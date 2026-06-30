import { CONFIG } from "./config";
import { saveRawEvent, saveSnapshot } from "./recorder";
import { openPaperTrade, updateTrade } from "./paper_wallet";
import { upsertToken, getLatestSnapshot } from "./db";
import type {
  DbotxMessage,
  DbotxNewPairInfo,
  DbotxPairInfo,
  DbotxSubscribeAck,
} from "./models";

const RECONNECT_DELAY_MS = 5_000;
const PING_INTERVAL_MS = 30_000;

/** Reverse lookup: pair address → token mint. */
const pairToMint = new Map<string, string>();

/** Forward lookup: token mint → pair address (survives reconnect). */
const mintToPair = new Map<string, string>();

/** Ordered list of mints subscribed for `pairInfo` updates. */
const subscribedMints: string[] = [];

/**
 * FIFO queue of mints that have received `newPairInfo` but have not yet
 * received their first identifiable `pairInfo` update. Drained in order
 * as the first unidentifiable updates arrive.
 */
const pendingFirstPrice: string[] = [];

/** Timestamp (ms) when each mint was added to pendingFirstPrice. */
const pendingFirstPriceTimestamps = new Map<string, number>();

const PENDING_SWEEP_MS = 120 * 1_000;

/** Cooldown: prevent duplicate BUYs for the same mint within this window. */
const TRADE_COOLDOWN_MS = 60 * 1_000;
const lastTradeOpenAt = new Map<string, number>();

/**
 * Last known price per mint (SOL) with timestamp. Used for
 * consistency-based matching when no explicit identifier is available.
 * Entries older than STALE_MS are skipped during matching.
 */
const lastPrice = new Map<string, { price: number; ts: number }>();
const STALE_MS = 10 * 60 * 1_000;

/** Round-robin index for absolute fallback. */
let subIndex = 0;

let ws: WebSocket | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// Message type guards
// ---------------------------------------------------------------------------

function isAck(msg: unknown): msg is DbotxSubscribeAck {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "status" in msg &&
    (msg as DbotxSubscribeAck).status === "ack"
  );
}

function isNewPairInfo(msg: unknown): msg is DbotxNewPairInfo {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "type" in msg &&
    (msg as DbotxNewPairInfo).type === "newPairInfo"
  );
}

function isPairInfo(msg: unknown): msg is DbotxPairInfo {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "type" in msg &&
    (msg as DbotxPairInfo).type === "pairInfo"
  );
}

function sendSubscribe(type: string, args: Record<string, unknown> = {}): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ method: "subscribe", type, args }));
}

function sendUnsubscribe(type: string, args: Record<string, unknown> = {}): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ method: "unsubscribe", type, args }));
}

// ---------------------------------------------------------------------------
// Identifier extraction
// ---------------------------------------------------------------------------

const MINT_FIELDS = [
  "m", "mint", "token", "token_mint", "mint_address",
  "base", "base_mint", "baseMint",
] as const;

const PAIR_FIELDS = [
  "p", "pair", "pair_address", "pairAddress", "symbol", "pool", "poolId",
] as const;

function identifyMint(
  msg: Record<string, unknown>,
  result: Record<string, unknown>,
  pairMap: Map<string, string>,
  subscribed: string[],
): { mint: string; source: string } | null {
  /* 1. Check message envelope for direct mint identifiers */
  for (const key of MINT_FIELDS) {
    const val = msg[key];
    if (typeof val === "string" && val.length > 0) {
      return { mint: val, source: `msg.${key}` };
    }
  }

  /* 2. Check message envelope for pair → mint lookup */
  for (const key of PAIR_FIELDS) {
    const val = msg[key];
    if (typeof val === "string" && val.length > 0) {
      const mint = pairMap.get(val);
      if (mint) return { mint, source: `msg.${key}` };
    }
  }

  /* 3. Check result for direct mint identifiers */
  for (const key of MINT_FIELDS) {
    const val = result[key];
    if (typeof val === "string" && val.length > 0) {
      return { mint: val, source: `result.${key}` };
    }
  }

  /* 4. Check result for pair → mint lookup */
  for (const key of PAIR_FIELDS) {
    const val = result[key];
    if (typeof val === "string" && val.length > 0) {
      const mint = pairMap.get(val);
      if (mint) return { mint, source: `result.${key}` };
    }
  }

  /* 5. Channel/subscription/topic fields */
  for (const key of ["channel", "subscription", "topic", "stream", "sub", "sid", "id"] as const) {
    const val = result[key] ?? msg[key];
    if (typeof val === "string" && val.length > 0) {
      if (pairMap.has(val)) return { mint: val, source: `${key}→map` };
      /* base58 inference — only accept if it matches a known subscription */
      if (subscribed.includes(val) && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(val)) {
        return { mint: val, source: `${key}→infer` };
      }
    }
  }

  return null;
}

/**
 * Match an incoming pairInfo to a mint by comparing the incoming token
 * price against each tracked token's last known price. The closest
 * relative match within a narrow band is selected.  Stale entries
 * (older than STALE_MS) are skipped.
 */
function matchByPrice(
  incomingPrice: number,
  priceMap: Map<string, { price: number; ts: number }>,
  now: number,
): string | null {
  let best: string | null = null;
  let bestRelDiff = Infinity;

  for (const [mint, entry] of priceMap) {
    if (entry.price <= 0) continue;
    if (now - entry.ts > STALE_MS) continue;
    const relDiff = Math.abs(incomingPrice - entry.price) / entry.price;
    if (relDiff < 0.1 && relDiff < bestRelDiff) {
      bestRelDiff = relDiff;
      best = mint;
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

let unidentifiedCount = 0;

function logUnidentifiedKeys(msg: Record<string, unknown>, result: Record<string, unknown>): void {
  if (unidentifiedCount >= 5) return;
  unidentifiedCount++;

  const msgKeys = Object.keys(msg).filter((k) => k !== "result");
  const resultKeys = Object.keys(result);
  console.warn(
    `[ws] unidentified pairInfo #${unidentifiedCount} – msg keys: [${msgKeys.join(", ")}], result keys: [${resultKeys.join(", ")}]`,
  );
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleNewPairInfo(msg: DbotxNewPairInfo): Promise<void> {
  const pair = msg.result.p;
  const mint = msg.result.m;

  if (!mint || !pair) {
    console.warn("[ws] newPairInfo missing mint/pair, skipping");
    await saveRawEvent(Date.now(), "newPairInfo", mint ?? null, pair ?? null, msg);
    return;
  }

  const initialLiquiditySol = msg.result.sl
    ? msg.result.sl / 1_000_000_000
    : null;

  const rawJson = JSON.stringify(msg);

  await saveRawEvent(Date.now(), "newPairInfo", mint, pair, msg);

  await upsertToken(mint, pair, null, null, initialLiquiditySol, rawJson);

  if (!subscribedMints.includes(mint)) {
    subscribedMints.push(mint);
    pairToMint.set(pair, mint);
    mintToPair.set(mint, pair);

    /*
     * Subscribe with multiple potential identifier fields.
     * If DBotX echoes any of them back, we can match deterministically.
     */
    sendSubscribe("pairInfo", {
      pair,
      token: mint,
      channel: mint,
      subId: mint,
    });
  }

  /* defer trade opening – wait for first observable price */
  if (!pendingFirstPrice.includes(mint)) {
    pendingFirstPrice.push(mint);
    pendingFirstPriceTimestamps.set(mint, Date.now());
  }
}

async function handlePairInfo(msg: DbotxPairInfo): Promise<void> {
  const now = Date.now();
  const rawJson = JSON.stringify(msg);
  const result = msg.result as Record<string, unknown>;
  const msgObj = msg as unknown as Record<string, unknown>;

  const incomingPrice = (result.tp as number) ?? 0;

  let mint: string | null = null;
  let isFirstPrice = false;

  /*
   * Step 1 – Try deterministic identification.
   * If the identified mint is waiting for its first price, claim it.
   */
  const identified = identifyMint(msgObj, result, pairToMint, subscribedMints);
  if (identified) {
    mint = identified.mint;
    const idx = pendingFirstPrice.indexOf(mint);
    if (idx !== -1) {
      pendingFirstPrice.splice(idx, 1);
      pendingFirstPriceTimestamps.delete(mint);
      isFirstPrice = true;
    }
  }

  /*
   * Step 2 – First-update FIFO queue.
   * Each pending mint just subscribed; the first update for any
   * subscription is likely to arrive in subscription order.
   */
  if (!mint && pendingFirstPrice.length > 0) {
    mint = pendingFirstPrice.shift()!;
    pendingFirstPriceTimestamps.delete(mint);
    isFirstPrice = true;
  }

  /*
   * Step 3 – Price consistency matching.
   * Compare the incoming price against each token's last known price.
   */
  if (!mint && incomingPrice > 0 && lastPrice.size > 0) {
    mint = matchByPrice(incomingPrice, lastPrice, now);
  }

  /*
   * Step 4 – Absolute fallback: round-robin.
   */
  if (!mint) {
    if (subscribedMints.length === 0) return;
    mint = subscribedMints[subIndex % subscribedMints.length]!;
    subIndex++;
    logUnidentifiedKeys(msgObj, result);
  }

  /* update last known price with timestamp for future matching */
  if (incomingPrice > 0) {
    lastPrice.set(mint, { price: incomingPrice, ts: now });
  }

  await saveRawEvent(now, "pairInfo", mint, null, msg);
  await saveSnapshot(null, mint, result, rawJson);

  const priceSol = incomingPrice > 0 ? incomingPrice : null;
  const priceUsd = (result.tpu as number) ?? null;

  await upsertToken(
    mint, null, priceUsd,
    result.mp as number ?? null,
    result.cr as number ?? null,
    rawJson,
  );

  if (isFirstPrice) {
    if (incomingPrice === 0) {
      console.warn(
        `[ws] first price for ${mint.slice(0, 10)}.. has tp=0 – ` +
        `trade opened at pending price`,
      );
    }

    /* cooldown guard: skip if a trade was just opened for this mint */
    const lastOpen = lastTradeOpenAt.get(mint);
    const sinceLastOpen = lastOpen ? now - lastOpen : Infinity;
    if (sinceLastOpen < TRADE_COOLDOWN_MS) {
      console.warn(
        `[ws] cooldown: skipping duplicate BUY for ${mint.slice(0, 10)}.. ` +
        `(${sinceLastOpen}ms since last open)`,
      );
      return;
    }
    lastTradeOpenAt.set(mint, now);

    const pair = mintToPair.get(mint) ?? "";
    await openPaperTrade(mint, pair, priceSol, priceUsd, msg);

    /* first price also triggers an immediate PnL update */
    const { db } = await import("./db");
    const [tradeRow] = await db`
      SELECT id FROM trades
      WHERE mint = ${mint} AND open = 1
      ORDER BY entry_ts DESC LIMIT 1
    ` as { id: number }[];

    if (tradeRow) {
      await updateTrade(tradeRow.id, priceSol, priceUsd);
    }
    return;
  }

  /* update the open trade PnL */
  const { db } = await import("./db");
  const [tradeRow] = await db`
    SELECT id FROM trades
    WHERE mint = ${mint} AND open = 1
    ORDER BY entry_ts DESC LIMIT 1
  ` as { id: number }[];

  if (tradeRow) {
    await updateTrade(tradeRow.id, priceSol, priceUsd);
  }
}

// ---------------------------------------------------------------------------
// Subscription lifecycle
// ---------------------------------------------------------------------------

export function unsubscribeMint(mint: string): void {
  const idx = subscribedMints.indexOf(mint);
  if (idx !== -1) {
    subscribedMints.splice(idx, 1);
  }

  const pendingIdx = pendingFirstPrice.indexOf(mint);
  if (pendingIdx !== -1) {
    pendingFirstPrice.splice(pendingIdx, 1);
  }

  for (const [pair, m] of pairToMint) {
    if (m === mint) {
      pairToMint.delete(pair);
      mintToPair.delete(mint);
      break;
    }
  }

  lastPrice.delete(mint);
  pendingFirstPriceTimestamps.delete(mint);
  lastTradeOpenAt.delete(mint);

  sendUnsubscribe("pairInfo", { token: mint });
}

/**
 * Remove entries from pendingFirstPrice that have been waiting longer
 * than PENDING_SWEEP_MS.  Prevents unbounded growth when a `newPairInfo`
 * subscription never receives a corresponding `pairInfo`.
 */
export function sweepPendingFirstPrice(): void {
  const now = Date.now();
  for (let i = pendingFirstPrice.length - 1; i >= 0; i--) {
    const mint = pendingFirstPrice[i]!;
    const added = pendingFirstPriceTimestamps.get(mint);
    if (added !== undefined && now - added > PENDING_SWEEP_MS) {
      console.warn(
        `[ws] sweep: removing stale pending mint ${mint.slice(0, 10)}.. ` +
        `(waited ${((now - added) / 1_000).toFixed(0)}s)`,
      );
      pendingFirstPrice.splice(i, 1);
      pendingFirstPriceTimestamps.delete(mint);
    }
  }
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

async function onMessage(raw: string): Promise<void> {
  try {
    const msg: DbotxMessage = JSON.parse(raw);

    if (isAck(msg)) {
      console.log(`[ws] subscribed: ${msg.result.subscribed.join(", ")}`);
      return;
    }

    if (isNewPairInfo(msg)) {
      await handleNewPairInfo(msg);
      return;
    }

    if (isPairInfo(msg)) {
      await handlePairInfo(msg);
      return;
    }

    await saveRawEvent(Date.now(), "unknown", null, null, msg);
  } catch (err) {
    console.error("[ws] message error:", err);
  }
}

function onOpen(): void {
  console.log("[ws] connected");

  sendSubscribe("newPairInfo", {});

  for (const mint of subscribedMints) {
    const pair = mintToPair.get(mint);
    if (pair) {
      sendSubscribe("pairInfo", { pair, token: mint, channel: mint, subId: mint });
    } else {
      sendSubscribe("pairInfo", { token: mint, channel: mint, subId: mint });
    }
  }

  if (pingTimer) clearInterval(pingTimer);
  pingTimer = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) ws.ping();
  }, PING_INTERVAL_MS);
}

function onClose(): void {
  console.log("[ws] disconnected – reconnecting in %d ms", RECONNECT_DELAY_MS);
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
  setTimeout(connect, RECONNECT_DELAY_MS);
}

function onError(event: Event): void {
  console.error("[ws] error:", event);
}

export function connect(): void {
  if (ws) {
    ws.close();
    ws = null;
  }

  ws = new WebSocket(CONFIG.wsUrl, {
    headers: { "x-api-key": CONFIG.dbotxApiKey },
  });

  ws.addEventListener("open", onOpen);
  ws.addEventListener("close", onClose);
  ws.addEventListener("error", onError);

  ws.addEventListener("message", (event: MessageEvent) => {
    const raw =
      typeof event.data === "string"
        ? event.data
        : Buffer.from(event.data as ArrayBuffer).toString("utf8");

    onMessage(raw);
  });
}

export function disconnect(): void {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }
}
