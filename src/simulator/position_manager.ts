/**
 * simulator/position_manager.ts
 *
 * Reactive position lifecycle manager for the DBotX simulator.
 *
 * Lifecycle:
 *   1. acceptedSignal$ emits a new signal
 *   2. module calls simFastBuy() with TP/SL groups from config
 *   3. Server creates the order + individual TP/SL tasks
 *   4. Polling loops track:
 *      - /simulator/pnl_orders_from_swap_order → TP/SL task states
 *      - /simulator/trade_pairs → live per-position PnL
 *      - /simulator/trades → trade history for entry price
 *   5. pairUpdate$ from the data WS feeds trailing stop logic
 *   6. When all exit events fire, position is marked closed
 *   7. positionClosed$ emits the final result for analytics
 *
 * No classes. State lives in a scan-based store driven by commands.
 */

import { Subject, timer, Observable } from "rxjs";
import {
  filter,
  map,
  scan,
  share,
  shareReplay,
  concatMap,
  withLatestFrom,
} from "rxjs/operators";
import { CONFIG } from "../config";
import { acceptedSignal$ } from "../telegram/signals_stream";
import type { SolanaPoolSignal } from "../telegram/ave_scanner_parser";
import { simFastBuy, simFastSell } from "./fast_buy_sell";
import type { ProfitLossGroup } from "./fast_buy_sell";
import { pairUpdate$ } from "../market/dbotx_data_ws";
import { refreshAccount$ } from "./account";
import { fetchWithRetry } from "./http";
import { getDailyPnlUsd } from "../analytics/reports";

/* ============================================================
 * Section 1: API Response Types
 *
 * Mirrors the JSON shapes returned by servapi.dbotx.com
 * simulator endpoints.
 * ============================================================
 */

export interface SimTokenInfo {
  contract: string;
  name: string;
  symbol: string;
  decimals: number;
  icon?: string;
  totalSupply: string | null;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  createAt: number | null;
}

export interface SimCurrencyInfo {
  contract: string;
  name: string;
  symbol: string;
  decimals: number;
  icon?: string;
  totalSupply: string | null;
  createAt: number | null;
}

export interface PnLTask {
  _id: string;
  accountId: string;
  enabled: boolean;
  chain: string;
  pairType: string;
  pair: string;
  token: string;
  tokenInfo: SimTokenInfo;
  currency: string;
  currencyInfo: SimCurrencyInfo;
  walletId: string | null;
  tradeType: "sell";
  triggerDirection: "up" | "down";
  triggerPriceUsd: number;
  currencyAmountUI: number;
  expireAt: number;
  expireDelta: number;
  expireExecute: boolean;
  useMidPrice: boolean;
  source: "swap_order";
  sourceId: string;
  sourceTradeId: string;
  sourceGroupIdx: number;
  basePriceUsd: number;
  initPnlPercent: number;
  maxSlippage: number;
  priorityFee: string;
  state: "init" | "done" | "fail" | "expired";
  lastStateUpdateAt: number;
  createAt: number;
  updateAt: number;
  errorCode: string;
  errorMessage: string;
  triggerPercent: number;
}

export interface TradePair {
  _id: string;
  chain: string;
  tokenInfo0: SimTokenInfo;
  tokenInfo1: SimCurrencyInfo;
  token0Balance: string;
  costUsd: number;
  lastTradeType: "buy" | "sell";
  lastTradeTime: number;
  buyTokenAmount: string;
  buyCostUsd: number;
  sellTokenAmount: string;
  sellReceiveUsd: number;
  sellProfitPercent: number | null;
  sellProfitUsd: number | null;
  fullProfitPercent: number;
  fullProfitUsd: number;
  links: { dexscreener: string; uniswap: string };
}

export interface TradeRecord {
  _id: string;
  id: string;
  source: "swap_order";
  subSource: string | null;
  chain: string;
  pair: string;
  timestamp: number;
  createAt: number;
  type: "buy" | "sell";
  totalUsd: number;
  sendToken: { info: SimCurrencyInfo; amount: string };
  receiveToken: { info: SimTokenInfo; amount: string };
  taxRate: number;
  taxAmount: string;
  priceUsd: number;
  token: { info: SimTokenInfo; balance: string };
  totalFeeUsd: number;
  links: { dexscreener: string; uniswap: string };
}

interface SimApiResponse<T> {
  err: boolean;
  res: T;
  docs?: string;
}

/* ============================================================
 * Section 2: Domain Types
 * ============================================================
 */

export interface PnLTaskSnapshot {
  groupIdx: number;
  state: "init" | "done" | "fail" | "expired";
  triggerPriceUsd: number;
  basePriceUsd: number;
  amountPercent: number;
  pnlPercent: number;
}

export type CloseReason =
  | "take_profit"
  | "stop_loss"
  | "trailing_stop"
  | "expired"
  | "manual";

export type PositionStatus = "open" | "closing" | "closed";

export interface PositionState {
  orderId: string;
  pair: string;
  token: string;
  tokenName: string;
  entryPriceUsd: number | null;
  entryCostUsd: number | null;
  sizeSol: number;
  peakPriceUsd: number;
  trailingActive: boolean;
  tasks: Map<number, PnLTaskSnapshot>;
  currentProfitPercent: number;
  currentProfitUsd: number;
  remainingBalance: string;
  openedAt: number;
  lastUpdateAt: number;
  status: PositionStatus;
  closeReason: CloseReason | null;
  signal: SolanaPoolSignal;
}

export interface PositionEvent {
  type: "opened" | "updated" | "task_update" | "trailing_triggered" | "closed";
  position: PositionState;
  closeReason?: CloseReason;
  detail?: string;
}

/* ============================================================
 * Section 3: Configuration Helpers
 * ============================================================
 */

const EXEC_DEFAULTS: {
  chain: "solana";
  walletId: string;
  priorityFee: number | "";
  slippage: number;
} = {
  chain: "solana",
  walletId: "",
  priorityFee: "",
  slippage: 0.1,
};

function buildStopEarnGroup(): ProfitLossGroup[] | undefined {
  const { partialTpTiers, backstopTpPct } = CONFIG;
  const groups: ProfitLossGroup[] = [];

  for (const tier of partialTpTiers) {
    groups.push({ pricePercent: tier.at, amountPercent: tier.pct });
  }

  if (backstopTpPct > 0) {
    const soldSoFar = partialTpTiers.reduce((sum, t) => sum + t.pct, 0);
    const remaining = 1 - soldSoFar;

    if (remaining > 0.001) {
      groups.push({ pricePercent: backstopTpPct, amountPercent: remaining });
    }
  }

  return groups.length > 0 ? groups : undefined;
}

function buildStopLossPercent(): number | undefined {
  const pct = Math.abs(CONFIG.stopLossPct);
  return pct > 0 ? pct : undefined;
}

/* ---------------------------------------------------------------
 * Dedup guard for pending buy orders
 *
 * Prevents double-buying when a request times out but the DBotX
 * server already created the order.  Pairs are kept in this set
 * for 60 seconds after the buy attempt begins.
 * ------------------------------------------------------------ */

const _pendingBuys = new Set<string>();
const PENDING_BUY_TTL_MS = 60_000;

function markPendingBuy(pair: string): void {
  _pendingBuys.add(pair);
  setTimeout(() => _pendingBuys.delete(pair), PENDING_BUY_TTL_MS);
}

function isPendingBuy(pair: string): boolean {
  return _pendingBuys.has(pair);
}

/* ---------------------------------------------------------------
 * Signal queue — FIFO queue for signals that arrive while at
 * max positions.  When a position closes the oldest queued signal
 * is dequeued and processed.
 * ------------------------------------------------------------ */

const _signalQueue = new Map<string, SolanaPoolSignal>();

function enqueueSignal(signal: SolanaPoolSignal): void {
  _signalQueue.set(signal.lpAddress, signal);

  /* Evict oldest if over capacity. */
  if (_signalQueue.size > CONFIG.signalQueueSize) {
    const oldest = _signalQueue.keys().next().value;
    if (oldest) {
      _signalQueue.delete(oldest);
      console.log(
        `[position_manager] Queue full — dropped oldest signal ${oldest}`,
      );
    }
  }

  console.log(
    `[position_manager] Queued ${signal.tokenName} ` +
      `(queue size: ${_signalQueue.size})`,
  );
}

/** Dequeue the oldest signal from the queue. */
function dequeueSignal(): SolanaPoolSignal | undefined {
  const first = _signalQueue.keys().next().value;
  if (!first) return undefined;
  const signal = _signalQueue.get(first);
  _signalQueue.delete(first);
  return signal;
}

/* ============================================================
 * Section 4: API Fetch Functions
 * ============================================================
 */

const { baseUrl, servapiBaseUrl, dbotxApiKey } = CONFIG;

const API_HEADERS = { "x-api-key": dbotxApiKey };

function url(path: string, params?: Record<string, string | number>): string {
  const u = new URL(path);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") {
        u.searchParams.set(k, String(v));
      }
    }
  }
  return u.toString();
}

async function simGet<T>(
  base: string,
  path: string,
  params?: Record<string, string | number>,
): Promise<T> {
  const response = await fetchWithRetry(url(`${base}${path}`, params), {
    headers: API_HEADERS,
  });

  const json = (await response.json()) as SimApiResponse<T>;

  if (json.err) {
    throw new Error("[position_manager] API returned err: true");
  }

  return json.res;
}

export async function fetchPnLTasks(sourceId: string): Promise<PnLTask[]> {
  return simGet<PnLTask[]>(servapiBaseUrl, "/simulator/pnl_orders_from_swap_order", {
    sourceId,
    page: 0,
    size: 20,
    sort: "-1",
  });
}

export async function fetchTradePairs(balanceGt0: boolean): Promise<TradePair[]> {
  return simGet<TradePair[]>(servapiBaseUrl, "/simulator/trade_pairs", {
    page: 0,
    size: 20,
    chain: "solana",
    balanceGt0: balanceGt0 ? "true" : "false",
  });
}

async function fetchBuyTrade(orderId: string): Promise<TradeRecord | null> {
  const trades = await simGet<TradeRecord[]>(baseUrl, "/simulator/trades", {});
  return trades.find((t) => t.id === orderId) ?? null;
}

/* ============================================================
 * Section 5: Position Store
 *
 * scan-based reactive store driven by PositionCommand messages.
 * ============================================================
 */

interface PositionCommand {
  type: "upsert" | "patch" | "remove";
  pair: string;
  position?: PositionState;
  patch?: Partial<PositionState>;
}

const positionCommand$ = new Subject<PositionCommand>();

/**
 * Snapshot of the latest positions map, updated synchronously inside
 * the scan reducer.  Used by closePosition() and other functions
 * that need a synchronous read of the current state.
 */
let _latestPositions = new Map<string, PositionState>();

export const positions$: Observable<Map<string, PositionState>> = positionCommand$.pipe(
  scan((map, cmd) => {
    if (cmd.type === "remove") {
      map.delete(cmd.pair);
    } else if (cmd.type === "upsert" && cmd.position) {
      map.set(cmd.pair, cmd.position);
    } else if (cmd.type === "patch" && cmd.patch) {
      const existing = map.get(cmd.pair);
      if (existing) {
        map.set(cmd.pair, { ...existing, ...cmd.patch, lastUpdateAt: Date.now() });
      }
    }
    _latestPositions = new Map(map);
    return _latestPositions;
  }, new Map<string, PositionState>()),
  shareReplay({ bufferSize: 1, refCount: true }),
);

export const openPositions$: Observable<PositionState[]> = positions$.pipe(
  map((map) => {
    const open: PositionState[] = [];
    for (const pos of map.values()) {
      if (pos.status === "open" || pos.status === "closing") {
        open.push(pos);
      }
    }
    return open;
  }),
  shareReplay({ bufferSize: 1, refCount: true }),
);

function upsertPosition(position: PositionState): void {
  positionCommand$.next({ type: "upsert", pair: position.pair, position });
}

/**
 * Apply a partial update to a position.
 *
 * Because the merge happens inside the scan reducer (not via a
 * read-then-write on the observable), multiple patch calls in the
 * same synchronous tick are safe — each one operates on the result
 * of the previous one.
 */
function patchPosition(pair: string, patch: Partial<PositionState>): void {
  positionCommand$.next({ type: "patch", pair, patch });
}

/* ============================================================
 * Section 6: Position Event Bus
 * ============================================================
 */

const positionEventInput$ = new Subject<PositionEvent>();

export const positionEvent$: Observable<PositionEvent> =
  positionEventInput$.pipe(share());

export const positionClosed$: Observable<PositionEvent> = positionEvent$.pipe(
  filter((ev) => ev.type === "closed"),
);

function emitEvent(event: PositionEvent): void {
  if (event.type !== "task_update") {
    console.log(
      `[POSITION] ${event.position.tokenName}: ${event.type}` +
        (event.detail ? ` - ${event.detail}` : ""),
    );
  }
  positionEventInput$.next(event);
}

/* ============================================================
 * Section 7: TP/SL Task Polling
 *
 * Polls /simulator/pnl_orders_from_swap_order for every open
 * position and updates task state in the store.
 *
 * Emits task_update only when the aggregate state changes to
 * keep console and Telegram noise low.
 * ============================================================
 */

const PNL_TASK_POLL_MS = 5_000;

/** Tracks last-seen done count per orderId to suppress redundant events. */
const _lastDoneCount = new Map<string, number>();

const pnlTaskPoll$ = timer(PNL_TASK_POLL_MS, PNL_TASK_POLL_MS).pipe(
  withLatestFrom(openPositions$),
  filter(([, open]) => open.length > 0),
  concatMap(async ([, open]) => {
    for (const pos of open) {
      if (!pos.orderId) continue;
      try {
        const tasks = await fetchPnLTasks(pos.orderId);
        if (tasks.length === 0) continue;

        const taskMap = new Map<number, PnLTaskSnapshot>();
        let allDone = true;

        for (const t of tasks) {
          taskMap.set(t.sourceGroupIdx, {
            groupIdx: t.sourceGroupIdx,
            state: t.state,
            triggerPriceUsd: t.triggerPriceUsd,
            basePriceUsd: t.basePriceUsd,
            amountPercent: t.currencyAmountUI,
            pnlPercent: t.triggerPercent,
          });

          if (t.state === "init") allDone = false;
        }

        patchPosition(pos.pair, {
          tasks: taskMap,
          entryPriceUsd: pos.entryPriceUsd ?? tasks[0]?.basePriceUsd ?? null,
        });

        const doneCount = tasks.filter((t) => t.state === "done").length;
        const prevDone = _lastDoneCount.get(pos.orderId) ?? -1;

        if (doneCount !== prevDone) {
          _lastDoneCount.set(pos.orderId, doneCount);

          emitEvent({
            type: "task_update",
            position: { ...pos, tasks: taskMap },
            detail: `${doneCount}/${tasks.length} tasks done`,
          });
        }

        if (allDone && tasks.length > 0) {
          const reason: CloseReason = tasks.some((t) => t.state === "done")
            ? "take_profit"
            : "expired";
          closePosition(pos.pair, reason);
        }
      } catch (err) {
        console.error(`[position_manager] PnL poll failed for ${pos.tokenName}:`, err);
      }
    }
  }),
);

pnlTaskPoll$.subscribe();

/* ============================================================
 * Section 8: Trade Pair Polling
 *
 * Polls /simulator/trade_pairs for live per-position PnL data.
 * ============================================================
 */

const TRADE_PAIR_POLL_MS = 30_000;

const tradePairPoll$ = timer(TRADE_PAIR_POLL_MS, TRADE_PAIR_POLL_MS).pipe(
  withLatestFrom(openPositions$),
  filter(([, open]) => open.length > 0),
  concatMap(async ([, open]) => {
    try {
      const pairs = await fetchTradePairs(true);

      for (const pair of pairs) {
        const token = pair.tokenInfo0.contract;
        const matching = open.find((p) => p.token === token);
        if (!matching) continue;

        patchPosition(matching.pair, {
          remainingBalance: pair.token0Balance,
          currentProfitPercent: pair.fullProfitPercent,
          currentProfitUsd: pair.fullProfitUsd,
        });

        const balanceNum = Number(pair.token0Balance);
        if (balanceNum <= 0 && matching.status === "open") {
          closePosition(matching.pair, "take_profit");
        }
      }
    } catch (err) {
      console.error("[position_manager] Trade pair poll failed:", err);
    }
  }),
);

tradePairPoll$.subscribe();

/* ============================================================
 * Section 9: Trade History Polling
 *
 * Polls /simulator/trades after a buy to capture entry price.
 * ============================================================
 */

async function captureEntryPrice(
  orderId: string,
  pair: string,
): Promise<number | null> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const trade = await fetchBuyTrade(orderId);

      if (trade && trade.priceUsd > 0) {
        patchPosition(pair, {
          entryPriceUsd: trade.priceUsd,
          peakPriceUsd: trade.priceUsd,
          entryCostUsd: trade.totalUsd,
        });

        console.log(
          `[position_manager] Entry price for ${pair}: $${trade.priceUsd}`,
        );
        return trade.priceUsd;
      }
    } catch {
      /* Server may not have persisted the trade yet */
    }

    await new Promise((r) => setTimeout(r, 1_000));
  }

  console.warn(
    `[position_manager] Could not fetch entry price for order ${orderId}`,
  );
  return null;
}

/* ============================================================
 * Section 10: Trailing Stop Monitor
 *
 * Watches pairUpdate$ for open positions, tracks peak prices,
 * and triggers a sell when the trail distance is breached.
 * ============================================================
 */

function startTrailingMonitor(): void {
  const { trailingActivationPct, trailingDistancePct } = CONFIG;

  if (!trailingDistancePct || trailingDistancePct <= 0) return;

  pairUpdate$
    .pipe(
      withLatestFrom(openPositions$),
      filter(([update, open]) => {
        if (!update.priceUsd) return false;
        return open.some(
          (p) => p.pair === update.pair && p.entryPriceUsd !== null,
        );
      }),
      map(([update, open]) => {
        const pos = open.find((p) => p.pair === update.pair);
        if (!pos || !update.priceUsd) return null;

        const price = update.priceUsd;
        let { peakPriceUsd, trailingActive, entryPriceUsd } = pos;

        if (price > peakPriceUsd) {
          peakPriceUsd = price;
          patchPosition(pos.pair, { peakPriceUsd });
        }

        if (!trailingActive && entryPriceUsd !== null) {
          const activationPrice = entryPriceUsd * (1 + trailingActivationPct);

          if (price >= activationPrice) {
            trailingActive = true;
            patchPosition(pos.pair, { trailingActive: true });
            console.log(
              `[TRAILING] Activated for ${pos.tokenName} ` +
                `(price $${price} >= activation $${activationPrice})`,
            );
          }
        }

        return { pos, price, peakPriceUsd, trailingActive, entryPriceUsd };
      }),
      filter((v): v is NonNullable<typeof v> => v !== null),
      filter(({ trailingActive, peakPriceUsd, price, entryPriceUsd }) => {
        if (!trailingActive || entryPriceUsd === null) return false;
        return price <= peakPriceUsd * (1 - trailingDistancePct);
      }),
    )
    .subscribe(({ pos, price, peakPriceUsd }) => {
      const trailPrice = peakPriceUsd * (1 - trailingDistancePct);

      console.log(
        `[TRAILING] Triggered sell for ${pos.tokenName}: ` +
          `price $${price} dropped below trail $${trailPrice} ` +
          `(peak $${peakPriceUsd})`,
      );

      emitEvent({
        type: "trailing_triggered",
        position: pos,
        detail: `Price $${price} dropped below trail $${trailPrice}`,
      });

      closePosition(pos.pair, "trailing_stop");
    });
}

startTrailingMonitor();

/* ============================================================
 * Section 11: Position Lifecycle Helpers
 * ============================================================
 */

async function closePosition(pair: string, reason: CloseReason): Promise<void> {
  const pos = _latestPositions.get(pair);
  if (!pos || pos.status === "closed") return;

  patchPosition(pair, { status: "closing", closeReason: reason });

  try {
    if (reason === "trailing_stop" || reason === "expired") {
      const orderId = await simFastSell({
        pair: pos.pair,
        amountOrPercent: 1,
        ...EXEC_DEFAULTS,
      });

      console.log(
        `[position_manager] ${reason} sell for ${pos.tokenName}: ${orderId}`,
      );

      refreshAccount$.next();
    }
  } catch (err) {
    console.error(`[position_manager] Failed to sell ${pos.tokenName}:`, err);
  }

  const final: PositionState = {
    ...pos,
    status: "closed",
    closeReason: reason,
    lastUpdateAt: Date.now(),
  };

  upsertPosition(final);

  emitEvent({
    type: "closed",
    position: final,
    closeReason: reason,
    detail: `Closed via ${reason}`,
  });

  refreshAccount$.next();

  /* Process next queued signal if a slot just freed up. */
  processQueuedSignal();
}

/* ============================================================
 * Section 12: Signal Consumer
 *
 * Listens to acceptedSignal$ and routes each signal:
 *   - If at max positions → enqueue for later
 *   - Otherwise → open position immediately
 * ============================================================
 */

/**
 * Core buy logic — shared between direct signal processing and
 * dequeued signals.
 */
async function openPosition(signal: SolanaPoolSignal): Promise<void> {
  if (_latestPositions.has(signal.lpAddress) || isPendingBuy(signal.lpAddress)) {
    return;
  }
  if (CONFIG.dailyLossLimitUsd) {
    const todayPnl = getDailyPnlUsd();
    if (todayPnl <= -CONFIG.dailyLossLimitUsd) {
      console.log(
        `[position_manager] Daily loss limit reached ` +
          `(${todayPnl.toFixed(2)}) — skipping ${signal.tokenName}`,
      );
      return;
    }
  }

  const { positionSize } = CONFIG;
  const stopEarnGroup = buildStopEarnGroup();
  const stopLossPercent = buildStopLossPercent();

  markPendingBuy(signal.lpAddress);

  console.log(
    `[position_manager] Opening position for ${signal.tokenName} ` +
      `(${signal.lpAddress}) with ${positionSize} SOL`,
  );

  let orderId: string;

  try {
    orderId = await simFastBuy({
      pair: signal.lpAddress,
      amountOrPercent: positionSize,
      stopEarnGroup,
      stopLossPercent,
      ...EXEC_DEFAULTS,
    });
  } catch (err) {
    console.error(`[position_manager] Failed to buy ${signal.tokenName}:`, err);
    return;
  }

  const now = Date.now();

  const position: PositionState = {
    orderId,
    pair: signal.lpAddress,
    token: signal.contractAddress,
    tokenName: signal.tokenName ?? "unknown",
    entryPriceUsd: null,
    entryCostUsd: null,
    sizeSol: positionSize,
    peakPriceUsd: 0,
    trailingActive: false,
    tasks: new Map(),
    currentProfitPercent: 0,
    currentProfitUsd: 0,
    remainingBalance: "0",
    openedAt: now,
    lastUpdateAt: now,
    status: "open",
    closeReason: null,
    signal,
  };

  upsertPosition(position);

  emitEvent({
    type: "opened",
    position,
    detail: `${signal.tokenName} @ ${positionSize} SOL`,
  });

  captureEntryPrice(orderId, signal.lpAddress);
  refreshAccount$.next();
}

/** Try to dequeue and process the next queued signal. */
async function processQueuedSignal(): Promise<void> {
  const signal = dequeueSignal();
  if (!signal) return;

  console.log(
    `[position_manager] Dequeued ${signal.tokenName} — opening position`,
  );
  await openPosition(signal);
}

acceptedSignal$
  .pipe(
    concatMap(async (signal) => {
      let openCount = 0;
      for (const pos of _latestPositions.values()) {
        if (pos.status === "open" || pos.status === "closing") openCount++;
      }

      if (openCount >= CONFIG.maxPositions) {
        enqueueSignal(signal);
        return;
      }

      await openPosition(signal);
    }),
  )
  .subscribe();

/* ============================================================
 * Section 13: Position Expiry & TTL Renewal
 *
 * Closes positions that exceed their configured TTL, unless the
 * current profit is above TTL_RENEWAL_PROFIT_PERCENT — in that
 * case the TTL timer is reset by updating openedAt.
 * ============================================================
 */

const EXPIRY_CHECK_MS = 15_000;
const { baseTtlSecs, minProfitForTtlExtensionPct, maxTtlSecs } = CONFIG;

timer(EXPIRY_CHECK_MS, EXPIRY_CHECK_MS)
  .pipe(
    withLatestFrom(openPositions$),
    map(([, open]) => open),
  )
  .subscribe((open) => {
    const now = Date.now();
    const baseAge = baseTtlSecs * 1_000;
    const maxAge = maxTtlSecs * 1_000;

    for (const pos of open) {
      const elapsed = now - pos.openedAt;

      /* Hard cap: position must close by MAX_TTL_SECS, no renewal past it. */
      if (elapsed >= maxAge) {
        console.log(
          `[position_manager] Position ${pos.tokenName} hit max TTL ` +
            `(age ${(elapsed / 1_000).toFixed(0)}s >= ${maxTtlSecs}s)`,
        );
        closePosition(pos.pair, "expired");
        continue;
      }

      if (elapsed < baseAge) continue;

      /* Base TTL reached — renew if profit exceeds threshold. */
      if (
        minProfitForTtlExtensionPct > 0 &&
        pos.currentProfitPercent >= minProfitForTtlExtensionPct
      ) {
        patchPosition(pos.pair, { openedAt: now });
        console.log(
          `[position_manager] Renewed TTL for ${pos.tokenName} ` +
            `(profit ${(pos.currentProfitPercent * 100).toFixed(2)}% >= ` +
            `${(minProfitForTtlExtensionPct * 100).toFixed(2)}%)`,
        );
        continue;
      }

      console.log(
        `[position_manager] Position ${pos.tokenName} expired ` +
          `(age ${(elapsed / 1_000).toFixed(0)}s > ${baseTtlSecs}s)`,
      );
      closePosition(pos.pair, "expired");
    }
  });

/* ---------------------------------------------------------------
 * Startup state recovery
 *
 * On boot, fetch open trade pairs from the server and insert them
 * into the position store so polling loops pick them up.
 * ------------------------------------------------------------ */

async function recoverOpenPositions(): Promise<void> {
  try {
    const pairs = await fetchTradePairs(true);
    const now = Date.now();

    for (const p of pairs) {
      const entryPriceUsd = p.costUsd > 0 && Number(p.buyTokenAmount) > 0
        ? p.costUsd / Number(p.buyTokenAmount)
        : null;

      const pos: PositionState = {
        orderId: p._id,
        pair: p._id,
        token: p.tokenInfo0.contract,
        tokenName: p.tokenInfo0.name ?? p.tokenInfo0.symbol ?? "unknown",
        entryPriceUsd,
        entryCostUsd: p.costUsd,
        sizeSol: Number(p.buyTokenAmount) || 0,
        peakPriceUsd: 0,
        trailingActive: false,
        tasks: new Map(),
        currentProfitPercent: p.fullProfitPercent ?? 0,
        currentProfitUsd: p.fullProfitUsd ?? 0,
        remainingBalance: String(Number(p.buyTokenAmount) || 0),
        openedAt: now,
        lastUpdateAt: now,
        status: "open",
        closeReason: null,
        signal: {
          tokenName: p.tokenInfo0.name ?? p.tokenInfo0.symbol ?? "unknown",
          contractAddress: p.tokenInfo0.contract,
          lpAddress: p._id,
          tokenAddress: p.tokenInfo0.contract,
          initPriceRaw: "0",
          initPrice: 0,
          marketCapRaw: "0",
          marketCapUsd: 0,
          pairTokenAmount: 0,
          pairTokenSymbol: p.tokenInfo1.symbol ?? "",
          pairSolAmount: 0,
          dex: "",
        } as SolanaPoolSignal,
      };

      upsertPosition(pos);
      console.log(
        `[position_manager] Recovered open position: ${pos.tokenName} (${p._id})`,
      );
    }
  } catch (err) {
    console.error("[position_manager] Recovery failed:", err);
  }
}

recoverOpenPositions();
