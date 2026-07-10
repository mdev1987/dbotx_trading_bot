import { BehaviorSubject, Observable, Subject } from "rxjs";
import { CONFIG } from "../config";
import type { AveScannerSignal } from "../telegram/ave_scanner_parser";
import type {
  PerformanceReport,
  Position,
  PositionEvent,
  PriceInfo,
  SimAccount,
} from "../data_stream/types";
import type { TradingApi } from "./api";

let positionIdCounter = 0;
const positions = new Map<string, Position>();
const closedPositions: Position[] = [];

interface QueuedSignal {
  signal: AveScannerSignal;
  timestamp: number;
}

const signalQueue: QueuedSignal[] = [];

/** Synchronous guard: pairs currently being bought (reserved before any await) */
const pendingPairs = new Set<string>();

/** Synchronous guard: pairs currently being sold/closed */
const closingPairs = new Set<string>();

const openPositionsSubject = new BehaviorSubject<Position[]>([]);
const positionEventSubject = new Subject<PositionEvent>();
const positionClosedSubject = new Subject<PositionEvent>();
const signalQueueCountSubject = new BehaviorSubject<number>(0);

export const openPositions$: Observable<Position[]> =
  openPositionsSubject.asObservable();
export const positionEvent$: Observable<PositionEvent> =
  positionEventSubject.asObservable();
export const positionClosed$: Observable<PositionEvent> =
  positionClosedSubject.asObservable();
export const signalQueueCount$: Observable<number> =
  signalQueueCountSubject.asObservable();

let latestAccount: SimAccount = {
  balance: 1000,
  change24h: 0,
  changeAll: 0,
  holdTokens: 0,
};

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function broadcastPositions(): void {
  openPositionsSubject.next(
    [...positions.values()].filter((p) => p.status === "open"),
  );
}

function broadcastQueueCount(): void {
  signalQueueCountSubject.next(signalQueue.length);
}

function generateId(): string {
  return `pos_${++positionIdCounter}_${Date.now()}`;
}

function hasSameAddress(
  a: AveScannerSignal,
  b: AveScannerSignal,
): boolean {
  if (a.LP && b.LP && a.LP === b.LP) return true;
  if (a.CA && b.CA && a.CA === b.CA) return true;
  return false;
}

/* -------------------------------------------------------------------------- */
/*  Signal Queue                                                              */
/* -------------------------------------------------------------------------- */

export function enqueueSignal(signal: AveScannerSignal): void {
  const now = Date.now();
  const ttlMs = CONFIG.signalQueueTtlSecs * 1000;

  const duplicateIdx = signalQueue.findIndex((q) =>
    hasSameAddress(q.signal, signal),
  );
  if (duplicateIdx !== -1) {
    signalQueue[duplicateIdx] = { signal, timestamp: now };
    broadcastQueueCount();
    return;
  }

  const expiredIdx = signalQueue.findIndex(
    (q) => now - q.timestamp > ttlMs,
  );
  if (expiredIdx !== -1) {
    const removed = signalQueue.splice(expiredIdx, 1)[0];
    signalQueue.push({ signal, timestamp: now });
    broadcastQueueCount();
    return;
  }

  if (signalQueue.length >= CONFIG.signalQueueSize) {
    return;
  }

  signalQueue.push({ signal, timestamp: now });
  broadcastQueueCount();
}

export function cleanupExpiredSignals(): void {
  const now = Date.now();
  const ttlMs = CONFIG.signalQueueTtlSecs * 1000;
  const before = signalQueue.length;

  for (let i = signalQueue.length - 1; i >= 0; i--) {
    if (now - signalQueue[i]!.timestamp > ttlMs) {
      signalQueue.splice(i, 1);
    }
  }

  if (signalQueue.length !== before) broadcastQueueCount();
}

export function getSignalQueueSize(): number {
  return signalQueue.length;
}

function tryDequeue(api: TradingApi): void {
  cleanupExpiredSignals();

  const open = [...positions.values()].filter((p) => p.status === "open");
  if (open.length >= CONFIG.maxPositions) return;
  if (signalQueue.length === 0) return;

  const next = signalQueue.shift()!;
  broadcastQueueCount();
  openPosition(api, next.signal);
}

/* -------------------------------------------------------------------------- */
/*  Position Management                                                       */
/* -------------------------------------------------------------------------- */

export async function openPosition(
  api: TradingApi,
  signal: AveScannerSignal,
): Promise<Position | null> {
  // ── Synchronous check (atomic, no await before) ──────────────────────
  const pair = signal.LP;
  const tokenName = signal.Token ?? "Unknown";
  const tokenCA = signal.CA ?? "";

  if (!pair) return null;

  if (
    pendingPairs.has(pair) ||
    closingPairs.has(pair) ||
    positions.has(pair)
  ) {
    return null;
  }

  if (tokenCA) {
    const exists = [...positions.values()].some(
      (p) => p.token.toLowerCase() === tokenCA.toLowerCase(),
    );
    if (exists) return null;
  }

  const open = [...positions.values()].filter((p) => p.status === "open");
  if (open.length + pendingPairs.size >= CONFIG.maxPositions) {
    enqueueSignal(signal);
    return null;
  }

  // ── Reserve slot (synchronous, atomic) ──────────────────────────────
  pendingPairs.add(pair);

  console.log(
    `[Position] Buying ${tokenName} (${pair}) with ${CONFIG.positionSize} SOL`,
  );

  // ── Phase 1: Submit buy (fast, ~100ms HTTP) ─────────────────────────
  let orderId: string;
  try {
    orderId = await api.submitBuy(pair, CONFIG.positionSize, tokenName, tokenCA);
  } catch (error) {
    console.error(`[Position] submitBuy failed for ${tokenName}:`, error);
    pendingPairs.delete(pair);
    return null;
  }

  // ── Phase 2: Poll for completion (slow, ~30s — not blocking other buys) ──
  let result: import("../data_stream/types").SwapOrderResult;
  try {
    result = await api.waitForOrder(orderId);
  } catch (error) {
    console.error(`[Position] waitForOrder failed for ${tokenName}:`, error);
    pendingPairs.delete(pair);
    return null;
  }

  // ── Phase 3: Add position (synchronous re-check) ────────────────────
  // Re-check conditions; another buy for this pair might have completed first
  if (!pendingPairs.has(pair) || positions.has(pair)) {
    console.log(`[Position] Pair ${pair} no longer pending, skipping`);
    pendingPairs.delete(pair);
    return null;
  }

  const entryPrice = result.priceUsd ?? 0;
  if (!entryPrice || entryPrice <= 0) {
    console.warn(`[Position] Invalid entry price (${entryPrice}) for ${tokenName}, aborting`);
    pendingPairs.delete(pair);
    return null;
  }

  const openNow = [...positions.values()].filter((p) => p.status === "open");
  if (openNow.length >= CONFIG.maxPositions) {
    pendingPairs.delete(pair);
    enqueueSignal(signal);
    return null;
  }

  // API returns price directly in USD (both sim and live)
  const sizeToken = CONFIG.positionSize / entryPrice;

  const now = Date.now();
  const position: Position = {
    id: generateId(),
    orderId,
    pair,
    token: tokenCA,
    tokenName,
    entryPriceUsd: entryPrice,
    sizeSol: CONFIG.positionSize,
    sizeToken,
    openedAt: now,
    peakPriceUsd: entryPrice,
    currentPriceUsd: entryPrice,
    soldPct: 0,
    status: "open",
    lastUpdateAt: now,
    currentProfitPct: 0,
    partialTierIndex: 0,
    lastPriceTimestamp: now,
  };

  positions.set(pair, position);
  pendingPairs.delete(pair);
  broadcastPositions();

  positionEventSubject.next({ type: "opened", position });

  const ep = entryPrice >= 1 ? `$${entryPrice.toFixed(2)}` : `$${entryPrice.toFixed(10)}`;
  console.log(
    `[Position] Opened ${tokenName} @ ${ep} | ${CONFIG.positionSize} SOL`,
  );

  return position;
}

export async function closePosition(
  api: TradingApi,
  pair: string,
  reason: string,
): Promise<void> {
  // Synchronous guard: only one close per pair at a time
  if (closingPairs.has(pair)) return;
  closingPairs.add(pair);

  try {
    const pos = positions.get(pair);
    if (!pos || pos.status !== "open") {
      closingPairs.delete(pair);
      return;
    }

    // Capture the price that triggered the exit BEFORE any async operations.
    // A subsequent price tick can update currentPriceUsd during the sell,
    // so we freeze the exit price here for accurate PnL reporting.
    // For the Telegram exit price, prefer the price engine snapshot (real market data)
    // over the simulator's fill price, since the simulator often fills at entry price
    // regardless of actual market movement.
    const priceAtExitTrigger = pos.currentPriceUsd;

    const remainingPct = 1 - pos.soldPct;
    if (remainingPct > 0.001) {
      try {
        const result = await api.sell(pair, remainingPct);
        if (result.priceUsd != null) {
          pos.closePriceUsd = result.priceUsd;
        }
      } catch (error) {
        closingPairs.delete(pair);
        return;
      }
    }

    pos.status = "closed";
    pos.closeReason = reason;
    pos.closedAt = Date.now();
    pos.lastUpdateAt = Date.now();

    // Prefer the simulator's actual fill price when it reflects real movement.
    // If the simulator filled at entry price (±1%), it means the simulator's
    // internal model didn't simulate price impact — fall back to the market
    // snapshot (priceAtExitTrigger) that actually triggered the exit.
    const fillPrice = pos.closePriceUsd;
    const isSimFlat = fillPrice != null && Math.abs(fillPrice / pos.entryPriceUsd - 1) < 0.01;
    const exitPrice = isSimFlat ? priceAtExitTrigger : (fillPrice ?? priceAtExitTrigger ?? pos.currentPriceUsd);
    pos.closePriceUsd = exitPrice;
    pos.currentProfitPct =
      pos.entryPriceUsd > 0
        ? (exitPrice - pos.entryPriceUsd) / pos.entryPriceUsd
        : 0;

    closedPositions.push({ ...pos });
    positions.delete(pair);
    closingPairs.delete(pair);
    broadcastPositions();

    console.log(`[Position] Closed ${pos.tokenName} (${reason})`);

    positionEventSubject.next({ type: "closed", position: pos, reason });
    positionClosedSubject.next({ type: "closed", position: pos, reason });

    tryDequeue(api);
  } catch (error) {
    console.error(`[Position] closePosition error for ${pair}:`, error);
    closingPairs.delete(pair);
  }
}

export async function handlePriceUpdate(
  api: TradingApi,
  update: PriceInfo,
): Promise<void> {
  const now = Date.now();

  for (const pos of positions.values()) {
    if (pos.status !== "open") continue;

    const match =
      pos.token.toLowerCase() === update.token.toLowerCase() ||
      pos.pair.toLowerCase() === update.token.toLowerCase() ||
      (update.pair != null &&
        (pos.token.toLowerCase() === update.pair.toLowerCase() ||
          pos.pair.toLowerCase() === update.pair.toLowerCase()));

    if (!match) continue;

    // Timestamp regression guard
    if (update.timestamp <= pos.lastPriceTimestamp) continue;

    const price = update.priceUsd;
    if (!Number.isFinite(price) || price <= 0) continue;

    // Reject price spikes from bad data. If a single tick shows a change
    // beyond the deviation limit (default 80%), it's almost certainly
    // a garbage price from a misconfigured source, not a real market move.
    const maxDevPct = CONFIG.maxPriceDeviationPct || 0.8;
    if (pos.currentPriceUsd > 0) {
      const change = Math.abs(price - pos.currentPriceUsd) / pos.currentPriceUsd;
      if (change > maxDevPct) continue;
    }

    pos.currentPriceUsd = price;
    pos.lastUpdateAt = now;
    pos.lastPriceTimestamp = update.timestamp;
    pos.priceSource = update.source;

    if (price > pos.peakPriceUsd) {
      pos.peakPriceUsd = price;
      console.log(`[Position] ${pos.tokenName} new ATH $${price.toFixed(10)}`);
    }

    pos.currentProfitPct =
      pos.entryPriceUsd > 0
        ? (price - pos.entryPriceUsd) / pos.entryPriceUsd
        : 0;

    const peakProfitPct =
      pos.entryPriceUsd > 0
        ? (pos.peakPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd
        : 0;

    // Order: Hard SL → Partial TP → Trailing Stop → Trailing TP
    // All checks run on every price update (no min-hold guard).
    // BASE_TTL_SECS only applies to TTL expiry (checkExpiredPositions), not to price exits.
    // No await between checks — closePosition/closingPairs guards prevent duplicates
    checkStopLoss(api, pos);
    checkPartialTP(api, pos, price);
    checkTrailingStop(api, pos, peakProfitPct);
    checkTrailingTP(api, pos, peakProfitPct);
  }
}

/* -------------------------------------------------------------------------- */
/*  TP / SL Logic                                                             */
/* -------------------------------------------------------------------------- */

async function checkStopLoss(
  api: TradingApi,
  pos: Position,
): Promise<void> {
  if (!CONFIG.stopLossPct) return;
  if (pos.status !== "open") return;
  if (closingPairs.has(pos.pair)) return;
  const slThreshold = -Math.abs(CONFIG.stopLossPct);
  if (pos.currentProfitPct <= slThreshold) {
    await closePosition(api, pos.pair, "stop_loss");
  }
}

async function checkTrailingStop(
  api: TradingApi,
  pos: Position,
  peakProfitPct: number,
): Promise<void> {
  if (
    CONFIG.trailingActivationPct <= 0 ||
    CONFIG.trailingDistancePct <= 0
  )
    return;
  if (pos.status !== "open") return;
  if (closingPairs.has(pos.pair)) return;
  if (peakProfitPct < CONFIG.trailingActivationPct) return;

  const drawdown = peakProfitPct - pos.currentProfitPct;
  if (drawdown >= CONFIG.trailingDistancePct) {
    await closePosition(api, pos.pair, "trailing_stop");
  }
}

async function checkTrailingTP(
  api: TradingApi,
  pos: Position,
  peakProfitPct: number,
): Promise<void> {
  if (CONFIG.trailingTpDistancePct <= 0) return;
  if (pos.status !== "open") return;
  if (closingPairs.has(pos.pair)) return;
  if (peakProfitPct < CONFIG.trailingTpDistancePct) return;

  const drawdown = peakProfitPct - pos.currentProfitPct;
  if (drawdown >= CONFIG.trailingTpDistancePct * 0.5) {
    await closePosition(api, pos.pair, "trailing_tp");
  }
}

async function checkPartialTP(
  api: TradingApi,
  pos: Position,
  currentPrice: number,
): Promise<void> {
  if (!CONFIG.partialTpEnabled) return;
  if (pos.status !== "open") return;
  if (closingPairs.has(pos.pair)) return;
  const tiers = CONFIG.partialTpTiers;
  if (tiers.length === 0) return;

  const profitPct =
    pos.entryPriceUsd > 0
      ? (currentPrice - pos.entryPriceUsd) / pos.entryPriceUsd
      : 0;

  while (pos.partialTierIndex < tiers.length) {
    const tier = tiers[pos.partialTierIndex]!;
    if (profitPct < tier.at) break;

    const remainingPct = 1 - pos.soldPct;
    if (remainingPct <= 0.001) {
      pos.partialTierIndex++;
      continue;
    }

    const tierTarget = tier.pct;
    const sellRatio = Math.min(tierTarget / remainingPct, 1);

    if (sellRatio < 0.01) {
      pos.partialTierIndex++;
      continue;
    }

    try {
      const result = await api.sell(pos.pair, sellRatio);
      pos.soldPct += tierTarget;
      pos.partialTierIndex++;

      positionEventSubject.next({
        type: "partial_sold",
        position: pos,
        soldPct: tierTarget,
        profitPct: profitPct,
      });
    } catch (error) {
      break;
    }
  }

  const totalSold = pos.soldPct;
  const backstopRemaining = 1 - totalSold;

  if (
    CONFIG.backstopTpPct > 0 &&
    backstopRemaining > 0.001 &&
    profitPct >= CONFIG.backstopTpPct
  ) {
    await closePosition(api, pos.pair, "take_profit");
  }
}

export async function checkExpiredPositions(api: TradingApi): Promise<void> {
  const now = Date.now();

  for (const pos of [...positions.values()]) {
    if (pos.status !== "open") continue;

    const ageMs = now - pos.openedAt;
    const ageSecs = ageMs / 1000;

    if (ageSecs < CONFIG.baseTtlSecs) continue;

    const isProfitable =
      CONFIG.minProfitForTtlExtensionPct > 0 &&
      pos.currentProfitPct >= CONFIG.minProfitForTtlExtensionPct;

    if (isProfitable && ageSecs < CONFIG.maxTtlSecs) {
      continue;
    }

    await closePosition(api, pos.pair, "expired");
  }
}

/* -------------------------------------------------------------------------- */
/*  Account Info                                                              */
/* -------------------------------------------------------------------------- */

export async function refreshAccountInfo(
  api: TradingApi,
): Promise<SimAccount> {
  try {
    latestAccount = await api.getAccountInfo();
    return latestAccount;
  } catch (error) {
    return latestAccount;
  }
}

export function getAccountInfo(): SimAccount {
  return latestAccount;
}

export function getOpenPositions(): Position[] {
  return [...positions.values()].filter((p) => p.status === "open");
}

/* -------------------------------------------------------------------------- */
/*  Report                                                                    */
/* -------------------------------------------------------------------------- */

export function getReport(): PerformanceReport {
  const open = [...positions.values()].filter((p) => p.status === "open");
  const all = [...closedPositions];

  const winningTrades = all.filter(
    (p) => (p.currentProfitPct ?? 0) >= 0,
  ).length;
  const losingTrades = all.filter(
    (p) => (p.currentProfitPct ?? 0) < 0,
  ).length;
  const closedCount = all.length;
  const totalPositions = open.length + closedCount;

  const totalProfitPct = all.reduce(
    (sum, p) => sum + (p.currentProfitPct ?? 0),
    0,
  );

  const profits = all.map((p) => p.currentProfitPct ?? 0);
  const bestTradePct = profits.length > 0 ? Math.max(...profits) : 0;
  const worstTradePct = profits.length > 0 ? Math.min(...profits) : 0;
  const avgProfitPct =
    profits.length > 0
      ? profits.reduce((s, v) => s + v, 0) / profits.length
      : 0;

  const reasons: Record<string, number> = {};
  for (const p of all) {
    const r = p.closeReason ?? "unknown";
    reasons[r] = (reasons[r] ?? 0) + 1;
  }

  return {
    openPositions: open.length,
    closedPositions: closedCount,
    totalPositions,
    winningTrades,
    losingTrades,
    winRate: closedCount > 0 ? (winningTrades / closedCount) * 100 : 0,
    totalProfitPct,
    totalProfitUsd: 0,
    bestTradePct,
    worstTradePct,
    avgProfitPct,
    avgProfitUsd: 0,
    reasons,
  };
}

export function getBalanceStr(): string {
  const change24 = latestAccount.change24h;
  const unit = CONFIG.liveMode ? "SOL" : "$";
  return [
    `\`${latestAccount.balance.toFixed(2)} ${unit}\``,
    `${change24 >= 0 ? "+" : ""}${(change24 * 100).toFixed(2)}% (24h)`,
  ].join(" · ");
}
