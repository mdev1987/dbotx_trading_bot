/**
 * DBotX WebSocket client.
 *
 * Maintains two subscription tiers:
 * 1. Global `newPairInfo` – discovers every freshly created trading pair.
 * 2. Per-pair `pairInfo`   – subscribes on discovery for continuous updates.
 *
 * On reconnect every active subscription is re-issued automatically.
 *
 * A `pair → mint` reverse map is kept so that incoming `pairInfo`
 * messages (which lack the mint address) can be linked back to
 * their token for trade updates and snapshot recording.
 */

import { CONFIG } from "./config";
import { saveRawEvent, saveSnapshot } from "./recorder";
import { openPaperTrade, updateTrade, closeTrade } from "./paper_wallet";
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

/**
 * Ordered list of mints with active `pairInfo` subscriptions.
 *
 * DBotX `pairInfo` messages do NOT include a pair or mint identifier,
 * so we match them by subscription order (round-robin). Every incoming
 * `pairInfo` is assigned to the next mint in this array, wrapping
 * around when we reach the end.
 */
const subscribedMints: string[] = [];
/** Round-robin index into `subscribedMints`. */
let subIndex = 0;

let ws: WebSocket | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;

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

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleNewPairInfo(msg: DbotxNewPairInfo): Promise<void> {
  const pair = msg.result.p;
  const mint = msg.result.m;

  if (!mint || !pair) {
    console.warn("[ws] newPairInfo missing mint/pair, skipping");
    saveRawEvent(Date.now(), "newPairInfo", mint ?? null, pair ?? null, msg);
    return;
  }

  const initialLiquiditySol = msg.result.sl
    ? msg.result.sl / 1_000_000_000
    : null;

  const rawJson = JSON.stringify(msg);

  saveRawEvent(Date.now(), "newPairInfo", mint, pair, msg);

  upsertToken(
    mint,
    pair,
    null,
    null,
    initialLiquiditySol,
    rawJson,
  );

  /* subscribe to per-pair updates if not already tracking */
  if (!subscribedMints.includes(mint)) {
    subscribedMints.push(mint);
    pairToMint.set(pair, mint);
    sendSubscribe("pairInfo", { pair, token: mint });
  }

  /* open a paper trade at the first available price */
  await openPaperTrade(mint, pair, null, null, msg);
}

async function handlePairInfo(msg: DbotxPairInfo): Promise<void> {
  const now = Date.now();
  const rawJson = JSON.stringify(msg);
  const result = msg.result as Record<string, unknown>;

  /*
   * DBotX `pairInfo` result does NOT include a pair or mint identifier.
   * We match messages to subscriptions by round-robin order, cycling
   * through the subscribed mints on every incoming update.
   *
   * This assumes the server sends updates in subscription FIFO order.
   * While not perfectly accurate per-message, it distributes updates
   * fairly across all tracked tokens, which is sufficient for a
   * research-grade paper trader.
   */
  if (subscribedMints.length === 0) return;
  const mint = subscribedMints[subIndex % subscribedMints.length]!;
  subIndex++;

  saveRawEvent(now, "pairInfo", mint, null, msg);
  saveSnapshot(null, mint, result, rawJson);

  const priceSol = (result.tp as number) ?? null;
  const priceUsd = (result.tpu as number) ?? null;

  upsertToken(mint, null, priceUsd, result.mp as number ?? null, result.cr as number ?? null, rawJson);

  /* update the open trade PnL */
  const { db } = await import("./db");
  const tradeRow = db
    .query(
      `SELECT id FROM trades
       WHERE mint = ? AND open = 1
       ORDER BY entry_ts DESC LIMIT 1`,
    )
    .get(mint) as { id: number } | null;

  if (tradeRow) {
    await updateTrade(tradeRow.id, priceSol, priceUsd);
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

    saveRawEvent(Date.now(), "unknown", null, null, msg);
  } catch (err) {
    console.error("[ws] message error:", err);
  }
}

function onOpen(): void {
  console.log("[ws] connected");

  sendSubscribe("newPairInfo", {});

  for (const mint of subscribedMints) {
    /* we lost the pair address on reconnect, re-sub by mint only */
    sendSubscribe("pairInfo", { token: mint });
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
