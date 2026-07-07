/**
 * Live Trading — Position Core.
 *
 * Central position store, event bus, and lifecycle API.
 *
 * Responsibilities:
 *   • Maintain an in-memory Map<number, PositionState> of all positions.
 *   • Expose RxJS subjects for position events (opened, updated, closing, closed).
 *   • Provide openPosition() which creates a live swap BUY order.
 *   • Provide closePositionById() which creates a live swap SELL order.
 *   • Subscribe to trade result WS events to automatically update position state.
 *   • Signal queue: when at max positions, enqueue signals for later.
 *   • Recovery: on startup, scan open swap orders to recover lost positions.
 *   • TTL tracking: positions are checked periodically and closed when expired.
 *   • Compute entry price from swap order completion (polling + WS).
 */
import { Subject, timer, Observable, Subscription } from "rxjs";
import { filter, map, withLatestFrom, tap } from "rxjs/operators";
import { LIVE_CONFIG } from "./config";
import type { ParsedSignal } from "../telegram/telegram_listener";
import type {
  PositionState,
  PositionEvent,
  CloseReason,
  PositionStatus,
  TradeResultEvent,
  LiveSwapOrderInfo,
  LiveBalance,
} from "./types";
import { liveFastBuy, liveFastSell, pollSwapOrderUntilDone, querySwapOrders, querySwapOrder } from "./fast_buy_sell";
import { computePositionSize } from "./account";
import { refreshBalance$ } from "./wallet";
import {
  tradeResultEvent$,
  buySuccessEvent$,
  sellSuccessEvent$,
  takeProfitSuccessEvent$,
  stopLossSuccessEvent$,
  trailingStopSuccessEvent$,
  tradeFailEvent$,
} from "./trade_results_ws";
import { pairUpdate$ } from "../market/dbotx_data_ws";
import {
  savePositionToDb,
  loadNonClosedPositions,
  markPositionDeletedFromDb,
  getLiveDb,
} from "./persistence";
import { isPanicMode, enablePanic } from "./panic";
import { markPriceUpdate } from "./watchdog";
import type { DbPositionRow } from "./persistence";

// ---------------------------------------------------------------------------
// Position ID counter — auto-incremented for each new position.
// ---------------------------------------------------------------------------

let nextPositionId = 1;

/** Generate the next unique position ID. */
function generatePositionId(): number {
  return nextPositionId++;
}

// ---------------------------------------------------------------------------
// Position store
// ---------------------------------------------------------------------------

/** Internal position map: position ID → PositionState. */
const _positionStore = new Map<number, PositionState>();

/** Snapshot for external consumers (e.g., strategies). */
export let _latestPositions: ReadonlyMap<number, PositionState> = _positionStore;

/**
 * Get a position by its order ID (live swap order ID).
 * Useful for WS event handlers that reference the order ID.
 */
export function getPositionByOrderId(orderId: string): PositionState | undefined {
  for (const pos of _positionStore.values()) {
    if (pos.orderId === orderId) return pos;
  }
  return undefined;
}

/**
 * Get a position by its token contract address.
 * @param token - Token contract address.
 * @returns The position if found, undefined otherwise.
 */
export function getPositionByToken(token: string): PositionState | undefined {
  for (const pos of _positionStore.values()) {
    if (pos.token === token && pos.status !== "closed") return pos;
  }
  return undefined;
}

/**
 * Get a position by its pair (LP) address.
 * @param pair - LP / pair address.
 * @returns The position if found, undefined otherwise.
 */
export function getPositionByPair(pair: string): PositionState | undefined {
  for (const pos of _positionStore.values()) {
    if (pos.pair === pair && pos.status !== "closed") return pos;
  }
  return undefined;
}

/**
 * Count currently open or closing positions.
 */
export function countOpenPositions(): number {
  let count = 0;
  for (const pos of _positionStore.values()) {
    if (pos.status === "open" || pos.status === "closing") count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Event bus
// ---------------------------------------------------------------------------

/**
 * Subject that emits PositionEvent objects for every lifecycle transition.
 * External consumers (telegram reporter, analytics, strategies) subscribe here.
 */
export const positionEvent$ = new Subject<PositionEvent>();

/**
 * Observable of just "opened" events — new positions created.
 */
export const positionOpened$: Observable<PositionState> = positionEvent$.pipe(
  filter((e): e is PositionEvent & { type: "opened" } => e.type === "opened"),
  map((e) => e.position),
);

/**
 * Observable of just "closed" events — positions that reached a terminal state.
 */
export const positionClosed$: Observable<PositionState> = positionEvent$.pipe(
  filter((e): e is PositionEvent & { type: "closed" } => e.type === "closed"),
  map((e) => e.position),
);

/**
 * Observable of open positions — emits whenever the store changes.
 */
export const openPositions$: Observable<PositionState[]> = positionEvent$.pipe(
  map(() => {
    const open: PositionState[] = [];
    for (const pos of _positionStore.values()) {
      if (pos.status === "open" || pos.status === "closing") open.push(pos);
    }
    return open;
  }),
);

/**
 * Emit a position event to the bus.
 * @param event - The event to emit.
 */
export function emitEvent(event: PositionEvent): void {
  positionEvent$.next(event);
}

// ---------------------------------------------------------------------------
// Position mutation helpers
// ---------------------------------------------------------------------------

/**
 * Add a new position to the store.
 * Called by openPosition() after the swap order is created.
 *
 * @param signal       - The parsed signal that triggered this position.
 * @param orderId      - The live swap order ID.
 * @param sizeSol      - The position size in SOL.
 * @returns The newly created position state.
 */
function addPosition(
  signal: ParsedSignal,
  orderId: string,
  sizeSol: number,
): PositionState {
  const now = Date.now();

  const position: PositionState = {
    id: generatePositionId(),
    orderId,
    pair: signal.lpAddress,
    token: signal.contractAddress,
    tokenName: signal.tokenName ?? "",
    tokenSymbol: "",
    entryPriceUsd: null,
    sizeSol,
    filledSol: 0,
    avgFillPriceUsd: null,
    peakPriceUsd: 0,
    trailingActive: false,
    currentProfitPercent: 0,
    currentProfitUsd: 0,
    openedAt: now,
    expiresAt: now + LIVE_CONFIG.baseTtlSecs * 1000,
    lastUpdateAt: now,
    status: "open",
    closeReason: null,
    exitPriceUsd: null,
    signal,
  };

  _positionStore.set(position.id, position);
  _totalSolDeployed += sizeSol;
  _latestPositions = _positionStore;

  /** Persist to SQLite before emitting events. */
  savePositionToDb(position);

  emitEvent({ type: "opened", position });

  return position;
}

/**
 * Update a position field by ID.
 * Emits an "updated" event.
 *
 * @param id    - Position ID.
 * @param patch - Partial fields to update.
 * @returns The updated position, or undefined if not found.
 */
export function patchPositionById(
  id: number,
  patch: Partial<PositionState>,
): PositionState | undefined {
  const pos = _positionStore.get(id);
  if (!pos) return undefined;

  Object.assign(pos, patch, { lastUpdateAt: Date.now() });
  savePositionToDb(pos);
  emitEvent({ type: "updated", position: pos });
  return pos;
}

/**
 * Begin closing a position: set status to "closing".
 * The actual sell is async; this signals that the position should not be
 * selected for new actions.
 *
 * @param id - Position ID.
 */
export function markPositionClosing(id: number): void {
  const pos = _positionStore.get(id);
  if (!pos || pos.status !== "open") return;
  pos.status = "closing";
  pos.lastUpdateAt = Date.now();
  savePositionToDb(pos);
  emitEvent({ type: "closing", position: pos });
}

/**
 * Mark a position as closed with the given reason and exit price.
 *
 * @param id          - Position ID.
 * @param reason      - Why the position was closed.
 * @param exitPriceUsd- Optional exit price in USD.
 */
export function markPositionClosed(
  id: number,
  reason: CloseReason,
  exitPriceUsd?: number,
): void {
  const pos = _positionStore.get(id);
  if (!pos || pos.status === "closed") return;

  pos.status = "closed";
  pos.closeReason = reason;
  pos.exitPriceUsd = exitPriceUsd ?? pos.exitPriceUsd;
  pos.lastUpdateAt = Date.now();

  /** Update profit before final close. */
  if (pos.entryPriceUsd && exitPriceUsd) {
    pos.currentProfitPercent = (exitPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd;
    pos.currentProfitUsd = pos.currentProfitPercent * pos.sizeSol;
  }

  /** Track daily loss (persisted to SQLite). */
  if (pos.currentProfitUsd < 0) {
    recordDailyLoss(pos.currentProfitUsd);
    persistDailyLoss();
  }

  /** Track consecutive losses for cooldown. */
  if (pos.currentProfitPercent < 0) {
    _consecutiveLosses++;
    if (_consecutiveLosses >= COOLDOWN_THRESHOLD) {
      _cooldownUntil = Date.now() + COOLDOWN_DURATION_MS;
      console.log(
        `[live/core] ${_consecutiveLosses} consecutive losses — ` +
          `cooling down for ${COOLDOWN_DURATION_MS / 1000}s`,
      );
    }
  } else {
    _consecutiveLosses = 0;
  }

  /** Release SOL from exposure tracking. */
  _totalSolDeployed = Math.max(0, _totalSolDeployed - pos.sizeSol);

  /** Persist to SQLite before emitting events. */
  savePositionToDb(pos);

  emitEvent({ type: "closed", position: pos, closeReason: reason });
}

// ---------------------------------------------------------------------------
// Pending-buy dedup guard
// ---------------------------------------------------------------------------

/**
 * Set of token addresses for which a buy order has been submitted but not yet
 * confirmed as done.  Prevents double-buying a token that already has a
 * pending order.
 */
const _pendingBuySet = new Set<string>();

/** Pending-buy timeout handles for auto-cleanup. */
const _pendingBuyTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Check if a token currently has a pending buy order.
 * @param token - Token contract address.
 * @returns True if a buy is already in progress.
 */
export function hasPendingBuy(token: string): boolean {
  return _pendingBuySet.has(token);
}

/**
 * Mark a token as having a pending buy.
 * Auto-expires after PENDING_BUY_TTL_MS.
 * @param token - Token contract address.
 */
export function addPendingBuy(token: string): void {
  /** Guard: already pending — clear old timer and return. */
  if (_pendingBuySet.has(token)) {
    const old = _pendingBuyTimers.get(token);
    if (old) clearTimeout(old);
    return;
  }
  _pendingBuySet.add(token);

  /** Set auto-cleanup timer. */
  const timer = setTimeout(() => {
    _pendingBuySet.delete(token);
    _pendingBuyTimers.delete(token);
  }, LIVE_CONFIG.pendingBuyTtlMs);

  _pendingBuyTimers.set(token, timer);
}

/**
 * Remove a token from the pending-buy set.
 * @param token - Token contract address.
 */
export function removePendingBuy(token: string): void {
  _pendingBuySet.delete(token);
  const timer = _pendingBuyTimers.get(token);
  if (timer) {
    clearTimeout(timer);
    _pendingBuyTimers.delete(token);
  }
}

// ---------------------------------------------------------------------------
// Pair+timestamp duplicate lock
// ---------------------------------------------------------------------------

/**
 * Set of "pair:rounded_timestamp" strings that prevents two buys for the
 * same pair within the configurable window (DUPLICATE_LOCK_WINDOW_MS).
 */
const _pairLockSet = new Set<string>();

/** Timer handles for auto-cleaning pair locks. */
const _pairLockTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Check if a pair is locked against duplicate buys.
 * @param pair - LP/pair address.
 * @returns True if the pair was recently bought.
 */
export function isPairLocked(pair: string): boolean {
  return _pairLockSet.has(pair);
}

/**
 * Lock a pair against duplicate buys for the configured window.
 * @param pair - LP/pair address.
 */
export function lockPair(pair: string): void {
  const windowMs = LIVE_CONFIG.duplicateLockWindowMs;
  const bucket = Math.floor(Date.now() / windowMs);
  const key = `${pair}:${bucket}`;

  _pairLockSet.add(key);

  const timer = setTimeout(() => {
    _pairLockSet.delete(key);
    _pairLockTimers.delete(key);
  }, windowMs + 100);

  _pairLockTimers.set(key, timer);
}

/**
 * Remove a pair lock (called after the buy order completes).
 * @param pair - LP/pair address.
 */
export function unlockPair(pair: string): void {
  const windowMs = LIVE_CONFIG.duplicateLockWindowMs;
  const bucket = Math.floor(Date.now() / windowMs);
  const key = `${pair}:${bucket}`;

  _pairLockSet.delete(key);
  const timer = _pairLockTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    _pairLockTimers.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Price cache from pairUpdate$ stream
// ---------------------------------------------------------------------------

/**
 * Map<pair, { priceUsd: number, timestamp: number }> — caches the latest
 * price from pairUpdate$ for price sanity checks and profit tracking.
 */
const _priceCache = new Map<string, { priceUsd: number; timestamp: number }>();

/** Update the price cache with a new value (called from subscribeToPriceUpdates). */
export function updatePriceCache(pair: string, priceUsd: number): void {
  _priceCache.set(pair, { priceUsd, timestamp: Date.now() });
}

/** Get a cached price for a pair. */
export function getCachedPrice(pair: string): { priceUsd: number; timestamp: number } | undefined {
  return _priceCache.get(pair);
}

// ---------------------------------------------------------------------------
// Exposure tracking
// ---------------------------------------------------------------------------

/** Total SOL deployed across all open positions. */
let _totalSolDeployed = 0;

/** Get total SOL currently in open positions. */
export function totalSolDeployed(): number {
  return _totalSolDeployed;
}

/** Consecutive losing trades — triggers cooldown after threshold. */
let _consecutiveLosses = 0;

/** Timestamp (ms) until which new positions are blocked by cooldown. */
let _cooldownUntil = 0;

/** Cooldown duration after consecutive losses (20 minutes). */
const COOLDOWN_DURATION_MS = 20 * 60 * 1000;

/** Consecutive losses needed to trigger cooldown. */
const COOLDOWN_THRESHOLD = 3;

/** Timestamps of recent buy orders for rate limiting. */
const _buyTimestamps: number[] = [];

/** Count buys in a rolling window (ms). */
function countBuysInWindow(windowMs: number): number {
  const cutoff = Date.now() - windowMs;
  let count = 0;
  for (const ts of _buyTimestamps) {
    if (ts >= cutoff) count++;
  }
  return count;
}

/** Check if the rate limit for buys is exceeded. */
export function isBuyRateLimited(): boolean {
  if (countBuysInWindow(60_000) >= LIVE_CONFIG.maxBuysPerMinute) {
    console.warn(`[live/core] Buy rate limit exceeded: ${countBuysInWindow(60_000)}/min`);
    return true;
  }
  if (countBuysInWindow(3_600_000) >= LIVE_CONFIG.maxBuysPerHour) {
    console.warn(`[live/core] Buy rate limit exceeded: ${countBuysInWindow(3_600_000)}/hour`);
    return true;
  }
  return false;
}

/** Record a buy timestamp for rate limiting. */
export function recordBuyTimestamp(): void {
  _buyTimestamps.push(Date.now());
  /** Prune old entries. */
  const cutoff = Date.now() - 3_600_000;
  while (_buyTimestamps.length > 0 && _buyTimestamps[0]! < cutoff) {
    _buyTimestamps.shift();
  }
}

// ---------------------------------------------------------------------------
// Consecutive API failure tracking
// ---------------------------------------------------------------------------

let _consecutiveApiFailures = 0;

/** Get the current consecutive failure count. */
export function consecutiveApiFailures(): number {
  return _consecutiveApiFailures;
}

/** Reset the consecutive failure counter (called on successful API call). */
export function resetApiFailures(): void {
  _consecutiveApiFailures = 0;
}

/** Increment and check the consecutive failure threshold. */
export function incrementApiFailures(): void {
  _consecutiveApiFailures++;
  if (_consecutiveApiFailures >= LIVE_CONFIG.maxConsecutiveApiFailures) {
    console.error(
      `[live/core] ${_consecutiveApiFailures} consecutive API failures — enabling panic`,
    );
    enablePanic();
  }
}

// ---------------------------------------------------------------------------
// Daily loss limit
// ---------------------------------------------------------------------------

let _dailyLossUsd = 0;

/**
 * Check if the daily loss limit has been exceeded.
 * Reloads from the database on each call.
 */
export function isDailyLossExceeded(): boolean {
  if (LIVE_CONFIG.dailyLossLimitUsd <= 0) return false;
  return _dailyLossUsd >= LIVE_CONFIG.dailyLossLimitUsd;
}

/**
 * Update the daily loss tracker with a realised PnL value.
 * Called when a position closes at a loss.
 */
export function recordDailyLoss(pnlUsd: number): void {
  if (pnlUsd >= 0) return;
  _dailyLossUsd += Math.abs(pnlUsd);
  if (isDailyLossExceeded()) {
    console.error(
      `[live/core] Daily loss limit reached: $${_dailyLossUsd.toFixed(2)} >= $${LIVE_CONFIG.dailyLossLimitUsd.toFixed(2)}`,
    );
  }
}

/**
 * Persist the current daily loss to SQLite.
 */
function persistDailyLoss(): void {
  try {
    const db = getLiveDb();
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(`
      INSERT INTO live_daily_loss (date, loss_usd)
      VALUES ($date, $loss_usd)
      ON CONFLICT(date) DO UPDATE SET
        loss_usd = loss_usd + $loss_usd,
        updated_at = (unixepoch() * 1000)
    `).run({
      $date: today,
      $loss_usd: _dailyLossUsd > 0 ? _dailyLossUsd : 0,
    });
  } catch (err) {
    console.error("[live/core] Failed to persist daily loss:", err);
  }
}

/**
 * Load today's daily loss from SQLite.
 */
export function loadDailyLossFromDb(): void {
  try {
    const db = getLiveDb();
    const today = new Date().toISOString().slice(0, 10);
    const row = db.prepare(
      "SELECT loss_usd FROM live_daily_loss WHERE date = $date",
    ).get({ $date: today }) as { loss_usd: number } | undefined;
    if (row) {
      _dailyLossUsd = row.loss_usd;
      console.log(`[live/core] Loaded daily loss from DB: $${_dailyLossUsd.toFixed(2)}`);
    }
  } catch (err) {
    console.error("[live/core] Failed to load daily loss from DB:", err);
  }
}

/**
 * Reset the daily loss counter (called at startup or when a new day begins).
 */
export function resetDailyLoss(): void {
  _dailyLossUsd = 0;
  persistDailyLoss();
}

// ---------------------------------------------------------------------------
// Open position — main entry point for strategies
// ---------------------------------------------------------------------------

/**
 * Open a new position for the given signal.
 *
 * Flow:
 *   1. Check dedup guard (pending buy, existing open position).
 *   2. Compute position size.
 *   3. Create live swap BUY order via API.
 *   4. Add position to store.
 *   5. Subscribe to WS / poll for order completion to capture entry price.
 *
 * @param signal - The parsed trading signal.
 * @returns The position ID, or 0 if the position could not be opened.
 */
export async function openPosition(signal: ParsedSignal): Promise<number> {
  /** Guard: LIVE_BUY_ENABLED kill switch. */
  if (!LIVE_CONFIG.liveBuyEnabled) {
    console.warn("[live/core] LIVE_BUY_ENABLED is false — rejecting new position");
    return 0;
  }

  /** Guard: panic mode — reject all new buys. */
  if (isPanicMode()) {
    console.warn("[live/core] Panic mode active — rejecting new position");
    return 0;
  }

  /** Guard: daily loss limit exceeded. */
  if (isDailyLossExceeded()) {
    console.warn(
      `[live/core] Daily loss limit ($${LIVE_CONFIG.dailyLossLimitUsd}) exceeded — rejecting new position`,
    );
    return 0;
  }

  /** Guard: buy rate limit. */
  if (isBuyRateLimited()) {
    console.warn("[live/core] Buy rate limit exceeded — rejecting new position");
    return 0;
  }

  /** Guard: max total SOL deployed. */
  if (LIVE_CONFIG.maxTotalSolDeployed > 0 && _totalSolDeployed >= LIVE_CONFIG.maxTotalSolDeployed) {
    console.warn(
      `[live/core] Max total SOL deployed (${LIVE_CONFIG.maxTotalSolDeployed}) reached — rejecting new position`,
    );
    return 0;
  }

  /** Guard: check for existing open position on this token. */
  const existing = getPositionByToken(signal.contractAddress);
  if (existing && existing.status !== "closed") {
    console.log(`[live/core] Token ${signal.tokenName} (${signal.contractAddress}) already has an open position — skipping`);
    return 0;
  }

  /** Guard: pending buy dedup. */
  if (hasPendingBuy(signal.contractAddress)) {
    console.log(`[live/core] Token ${signal.tokenName} already has a pending buy — skipping`);
    return 0;
  }

  /** Guard: pair+timestamp duplicate lock. */
  if (isPairLocked(signal.lpAddress)) {
    console.log(`[live/core] Pair ${signal.lpAddress} is locked (duplicate window) — skipping`);
    return 0;
  }

  /** Guard: price sanity check. */
  const cached = getCachedPrice(signal.lpAddress);
  if (cached && LIVE_CONFIG.maxPriceDeviationPct > 0) {
    if (cached.priceUsd <= 0) {
      console.warn(`[live/core] Cached price for ${signal.tokenName} is ${cached.priceUsd} — aborting`);
      return 0;
    }
  }

  /** Guard: consecutive loss cooldown. */
  const remaining = _cooldownUntil - Date.now();
  if (remaining > 0) {
    console.log(
      `[live/core] Cooldown active (${Math.ceil(remaining / 1000)}s remaining) — ` +
        `skipping ${signal.tokenName}`,
    );
    return 0;
  }

  /** Compute position size. */
  const sizeSol = computePositionSize();

  /** Mark as pending buy immediately. */
  addPendingBuy(signal.contractAddress);

  /** Lock the pair against duplicates. */
  lockPair(signal.lpAddress);

  try {
    /** Create the live BUY order. */
    const orderId = await liveFastBuy(signal.lpAddress, sizeSol, signal);

    /** Reset consecutive failure counter on success. */
    resetApiFailures();

    /** Add the position to the store. */
    const position = addPosition(signal, orderId, sizeSol);

    /** Record buy for rate limiting. */
    recordBuyTimestamp();

    /** Refresh wallet balance after the buy. */
    refreshBalance$.next();

    console.log(
      `[live/core] Position opened: id=${position.id} token=${signal.tokenName} ` +
        `orderId=${orderId} size=${sizeSol.toFixed(4)} SOL`,
    );

    /** Poll for order completion to get entry price (background, not awaited). */
    captureEntryPrice(position.id, orderId).catch((err) => {
      console.error(`[live/core] Failed to capture entry price for position ${position.id}:`, err);
    });

    return position.id;
  } catch (err) {
    /** Clean up pending buy on failure. */
    removePendingBuy(signal.contractAddress);

    /** Track API failure for circuit breaker. */
    incrementApiFailures();

    console.error(`[live/core] Failed to open position for ${signal.tokenName}:`, err);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Capture entry price after buy order completes
// ---------------------------------------------------------------------------

/**
 * Poll the swap order until it is done, then capture the entry price.
 *
 * @param positionId - ID of the position in the store.
 * @param orderId    - Live swap order ID to poll.
 */
async function captureEntryPrice(
  positionId: number,
  orderId: string,
): Promise<void> {
  try {
    const orderInfo = await pollSwapOrderUntilDone(orderId);

    if (orderInfo.txPriceUsd && orderInfo.txPriceUsd > 0) {
      patchPositionById(positionId, {
        entryPriceUsd: orderInfo.txPriceUsd,
        peakPriceUsd: orderInfo.txPriceUsd, // Initial peak = entry
      });
      console.log(
        `[live/core] Entry price captured for position ${positionId}: ` +
          `$${orderInfo.txPriceUsd.toFixed(8)}`,
      );
    } else {
      console.warn(
        `[live/core] Order ${orderId} done but no txPriceUsd — using fallback`,
      );
    }

    /** Remove from pending buy set now that order is done. */
    removePendingBuy(getTokenByPositionId(positionId) ?? "");
  } catch (err) {
    console.error(`[live/core] Entry price poll failed for order ${orderId}:`, err);
    /** Even on failure, clear the pending buy so new signals aren't blocked forever. */
    removePendingBuy(getTokenByPositionId(positionId) ?? "");
  }
}

/**
 * Get the token address for a position ID.
 */
function getTokenByPositionId(id: number): string | undefined {
  return _positionStore.get(id)?.token;
}

// ---------------------------------------------------------------------------
// Close position — called by trailing stop, TTL expiry, manual, etc.
// ---------------------------------------------------------------------------

/**
 * Close a position by submitting a live SELL order.
 *
 * @param id     - Position ID.
 * @param reason - Why the position is being closed.
 * @param cb     - Optional callback invoked with the sell order ID.
 */
export async function closePositionById(
  id: number,
  reason: CloseReason,
  cb?: (sellOrderId: string) => void,
): Promise<void> {
  const pos = _positionStore.get(id);
  if (!pos) {
    console.warn(`[live/core] closePositionById: position ${id} not found`);
    return;
  }

  /** Prevent double-close. */
  if (pos.status === "closed" || pos.status === "closing") return;

  /** Mark as closing immediately to prevent duplicate sells. */
  markPositionClosing(id);

  try {
    /** Submit the live sell order. */
    const sellOrderId = await liveFastSell(pos.pair);

    console.log(
      `[live/core] Closing position ${id} (${pos.tokenName}) with sell ${sellOrderId} ` +
        `reason=${reason}`,
    );

    if (cb) cb(sellOrderId);

    /** We do NOT mark the position closed here — the WS trade result event will do that. */
    /** However, we set a fallback timer in case the WS event never arrives. */
    scheduleSellFallback(id, sellOrderId, reason);
    } catch (err) {
    console.error(`[live/core] Failed to sell position ${id}:`, err);
    /** Track API failure for circuit breaker. */
    incrementApiFailures();
    /** Revert to open so the next attempt can try again. */
    pos.status = "open";
    pos.lastUpdateAt = Date.now();
    savePositionToDb(pos);
    emitEvent({ type: "updated", position: pos, detail: `Sell failed: ${err}` });
  }
}

/**
 * Schedule a fallback: if the WS sell event doesn't arrive within a reasonable
 * time, poll the sell order status and mark closed.
 */
function scheduleSellFallback(
  positionId: number,
  sellOrderId: string,
  reason: CloseReason,
): void {
  /** Wait 30 seconds for the WS event, then poll. */
  setTimeout(async () => {
    const pos = _positionStore.get(positionId);
    if (!pos || pos.status === "closed") return;

    console.log(`[live/core] Fallback: polling sell order ${sellOrderId} for position ${positionId}`);

    try {
      const orderInfo = await pollSwapOrderUntilDone(sellOrderId, 10, 3_000);
      markPositionClosed(positionId, reason, orderInfo.txPriceUsd);
    } catch (err) {
      console.error(`[live/core] Fallback sell poll failed for ${sellOrderId}:`, err);
    }
  }, 30_000);
}

// ---------------------------------------------------------------------------
// WS trade result event handlers
// ---------------------------------------------------------------------------

/**
 * Subscribe to trade result WS events and update position state accordingly.
 *
 * Returns a Subscription that can be unsubscribed to stop processing.
 */
export function subscribeToTradeEvents(): Subscription {
  const subs = new Subscription();

  /** Handle buy success events — capture entry price if not already captured. */
  subs.add(
    buySuccessEvent$
      .subscribe((event) => {
        const pos = getPositionByOrderId(event.result.id);
        if (!pos) {
          /** Could be a recovery position — log and skip. */
          console.log(`[live/core] Buy success for unknown order: ${event.result.id}`);
          return;
        }

        if (!pos.entryPriceUsd && event.result.priceUsd) {
          patchPositionById(pos.id, {
            entryPriceUsd: event.result.priceUsd,
            peakPriceUsd: event.result.priceUsd,
          });
          removePendingBuy(pos.token);
          console.log(
            `[live/core] WS: Entry price set for ${pos.tokenName} @ $${event.result.priceUsd}`,
          );
        }
      }),
  );

  /** Handle sell success events — mark position as closed. */
  subs.add(
    sellSuccessEvent$
      .subscribe((event) => {
        const pos = getPositionByOrderId(event.result.id);
        if (!pos) return;

        markPositionClosed(
          pos.id,
          "manual",
          event.result.priceUsd,
        );
        console.log(
          `[live/core] WS: Sell done for ${pos.tokenName} @ $${event.result.priceUsd}`,
        );
      }),
  );

  /** Handle take-profit success events. */
  subs.add(
    takeProfitSuccessEvent$
      .subscribe((event) => {
        const pos = getPositionByOrderId(event.result.id);
        if (!pos) return;

        markPositionClosed(
          pos.id,
          "take_profit",
          event.result.priceUsd,
        );
        console.log(
          `[live/core] WS: TP done for ${pos.tokenName} @ $${event.result.priceUsd}`,
        );
      }),
  );

  /** Handle stop-loss success events. */
  subs.add(
    stopLossSuccessEvent$
      .subscribe((event) => {
        const pos = getPositionByOrderId(event.result.id);
        if (!pos) return;

        markPositionClosed(
          pos.id,
          "stop_loss",
          event.result.priceUsd,
        );
        console.log(
          `[live/core] WS: SL done for ${pos.tokenName} @ $${event.result.priceUsd}`,
        );
      }),
  );

  /** Handle trailing stop success events. */
  subs.add(
    trailingStopSuccessEvent$
      .subscribe((event) => {
        const pos = getPositionByOrderId(event.result.id);
        if (!pos) return;

        markPositionClosed(
          pos.id,
          "trailing_stop",
          event.result.priceUsd,
        );
        console.log(
          `[live/core] WS: Trailing stop done for ${pos.tokenName} @ $${event.result.priceUsd}`,
        );
      }),
  );

  /** Handle failure events — log them prominently. */
  subs.add(
    tradeFailEvent$
      .subscribe((event) => {
        const pos = getPositionByOrderId(event.result.id);
        const tokenName = pos?.tokenName ?? event.result.symbol;
        console.error(
          `[live/core] WS: Trade FAILED for ${tokenName} ` +
            `type=${event.result.type} ` +
            `error=${event.result.errorMessage ?? event.result.errorCode ?? "unknown"}`,
        );
      }),
  );

  return subs;
}

// ---------------------------------------------------------------------------
// TTL expiry checker
// ---------------------------------------------------------------------------

/**
 * Start the TTL expiry checker that periodically scans open positions and
 * closes any that have exceeded their TTL.
 *
 * @returns A Subscription that can be unsubscribed to stop the checker.
 */
export function startTtlChecker(): Subscription {
  const { baseTtlSecs, minProfitForTtlExtensionPct, maxTtlSecs, expiryCheckMs } = LIVE_CONFIG;

  return timer(expiryCheckMs, expiryCheckMs)
    .pipe(
      withLatestFrom(openPositions$),
      tap(([, positions]) => {
        const now = Date.now();

        for (const pos of positions) {
          /** Skip positions that are already closing or have no entry price yet. */
          if (pos.status !== "open") continue;
          if (!pos.entryPriceUsd) continue;

          const age = now - pos.openedAt;
          const maxAge = maxTtlSecs * 1000;

          /** Hard cap: close if position exceeds maxTtlSecs. */
          if (maxTtlSecs > 0 && age >= maxAge) {
            console.log(
              `[live/core] Hard TTL cap reached for position ${pos.id} (${pos.tokenName}) ` +
                `— closing`,
            );
            closePositionById(pos.id, "expired").catch((err) => {
              console.error(`[live/core] TTL hard cap close failed for position ${pos.id}:`, err);
            });
            continue;
          }

          /** TTL extension: if profitable and extension configured, reset the TTL. */
          if (
            minProfitForTtlExtensionPct > 0 &&
            pos.currentProfitPercent >= minProfitForTtlExtensionPct
          ) {
            const newExpiry = now + baseTtlSecs * 1000;
            const wouldExceedCap = maxTtlSecs > 0 && newExpiry - pos.openedAt > maxAge;

            if (!wouldExceedCap) {
              patchPositionById(pos.id, { expiresAt: newExpiry });
              console.log(
                `[live/core] TTL extended for position ${pos.id} (${pos.tokenName}) ` +
                  `— profit ${(pos.currentProfitPercent * 100).toFixed(1)}% >= ` +
                  `${(minProfitForTtlExtensionPct * 100).toFixed(1)}%`,
              );
              continue;
            }
          }

          /** Normal TTL expiry check. */
          if (now >= pos.expiresAt) {
            console.log(
              `[live/core] TTL expired for position ${pos.id} (${pos.tokenName}) ` +
                `— closing`,
            );
            closePositionById(pos.id, "expired").catch((err) => {
              console.error(`[live/core] TTL close failed for position ${pos.id}:`, err);
            });
          }
        }
      }),
    )
    .subscribe();
}

// ---------------------------------------------------------------------------
// Price update subscription — update peak and profit for open positions
// ---------------------------------------------------------------------------

/**
 * Subscribe to pair price updates from the data WS and update open positions.
 * This powers the trailing stop and profit tracking.
 *
 * @returns A Subscription.
 */
export function subscribeToPriceUpdates(): Subscription {
  return pairUpdate$
    .pipe(
      withLatestFrom(openPositions$),
      tap(([update, positions]) => {
        /** Skip updates without a price. */
        if (update.priceUsd == null || update.priceUsd <= 0) return;

        /** Mark the price feed as alive. */
        markPriceUpdate();

        /** Update the global price cache. */
        updatePriceCache(update.pair, update.priceUsd);

        for (const pos of positions) {
          /** Match by LP address (pair). */
          if (pos.pair !== update.pair) continue;
          if (!pos.entryPriceUsd) continue;

          const currentPrice = update.priceUsd;
          if (!currentPrice || currentPrice <= 0) continue;

          /** Update peak price. */
          if (currentPrice > pos.peakPriceUsd) {
            pos.peakPriceUsd = currentPrice;
          }

          /** Update current profit. */
          pos.currentProfitPercent =
            (currentPrice - pos.entryPriceUsd) / pos.entryPriceUsd;
          pos.currentProfitUsd = pos.currentProfitPercent * pos.sizeSol;
          pos.lastUpdateAt = Date.now();
        }
      }),
    )
    .subscribe();
}

// ---------------------------------------------------------------------------
// Signal queue (FIFO, Map-based with LP dedup, full-scan TTL eviction)
// ---------------------------------------------------------------------------

const _signalQueue = new Map<string, { signal: ParsedSignal; timestamp: number }>();

function evictExpiredQueueEntries(): number {
  const now = Date.now();
  const maxAge = LIVE_CONFIG.signalQueueTtlSecs * 1000;
  let evicted = 0;
  for (const [lp, entry] of _signalQueue) {
    if (now - entry.timestamp >= maxAge) {
      _signalQueue.delete(lp);
      evicted++;
    }
  }
  return evicted;
}

/**
 * Enqueue a signal for later processing.
 * Deduplicates by LP address: removes the old entry first so the new
 * signal goes to the back of the FIFO order with a fresh TTL.
 * Evicts expired entries before checking capacity.
 * When full, removes the oldest non-expired entry.
 */
export function enqueueSignal(signal: ParsedSignal): void {
  const expired = evictExpiredQueueEntries();
  if (expired > 0) {
    console.log(`[live/core] Queue: evicted ${expired} expired signal(s)`);
  }

  /** Remove old entry for this LP (if any) so the new one lands at the back of the FIFO. */
  if (_signalQueue.has(signal.lpAddress)) {
    _signalQueue.delete(signal.lpAddress);
  }

  _signalQueue.set(signal.lpAddress, { signal, timestamp: Date.now() });

  if (_signalQueue.size > LIVE_CONFIG.signalQueueSize) {
    const oldest = _signalQueue.keys().next().value;
    if (oldest) {
      _signalQueue.delete(oldest);
      console.log(`[live/core] Queue: full — dropped oldest signal ${oldest}`);
    }
  }

  console.log(`[live/core] Queue: enqueued ${signal.tokenName} (${_signalQueue.size} queued)`);
}

/**
 * Dequeue the next valid signal, skipping expired entries.
 */
export function dequeueSignal(): ParsedSignal | null {
  const now = Date.now();
  const maxAge = LIVE_CONFIG.signalQueueTtlSecs * 1000;

  for (const lp of _signalQueue.keys()) {
    const entry = _signalQueue.get(lp)!;
    _signalQueue.delete(lp);

    if (now - entry.timestamp >= maxAge) {
      console.log(`[live/core] Queue: expired signal for ${entry.signal.tokenName}`);
      continue;
    }

    return entry.signal;
  }

  return null;
}

export function queueLength(): number {
  return _signalQueue.size;
}

export function _clearQueueForTest(): void {
  _signalQueue.clear();
}

// ---------------------------------------------------------------------------
// Recovery on startup
// ---------------------------------------------------------------------------

/**
 * Recover positions from SQLite on startup.
 *
 * Loads all non-closed (open/closing) positions from the database,
 * queries the exchange for their current state, and updates the
 * in-memory store accordingly.
 *
 * Steps:
 *   1. Load rows from SQLite where status != 'closed'.
 *   2. For each recovered position, query GET /automation/swap_orders
 *      for the current order state.
 *   3. If the order is done/fail/expired, update our state accordingly.
 *   4. If still pending, restore it as open.
 *   5. If order not found on exchange, keep it as open with a warning.
 */
export async function recoverOpenPositions(): Promise<void> {
  if (!LIVE_CONFIG.recoveryOnStart) {
    console.log("[live/core] Recovery on startup disabled — skipping");
    return;
  }

  console.log("[live/core] Recovery: loading positions from SQLite...");

  try {
    const rows = loadNonClosedPositions();

    if (rows.length === 0) {
      console.log("[live/core] Recovery: no non-closed positions found");
      return;
    }

    console.log(`[live/core] Recovery: found ${rows.length} non-closed positions`);

    for (const row of rows) {
      try {
        await recoverSinglePosition(row);
      } catch (err) {
        console.error(`[live/core] Recovery failed for position ${row.id}:`, err);
      }
    }

    console.log(
      `[live/core] Recovery complete: ${countOpenPositions()} open positions restored`,
    );
  } catch (err) {
    console.error("[live/core] Recovery scan failed:", err);
  }
}

/**
 * Recover a single position from a database row.
 */
async function recoverSinglePosition(row: DbPositionRow): Promise<void> {
  /** Parse the signal JSON if available. */
  let signal: ParsedSignal | undefined;
  if (row.signal_json) {
    try {
      signal = JSON.parse(row.signal_json) as ParsedSignal;
    } catch {
      console.warn(`[live/core] Recovery: failed to parse signal JSON for position ${row.id}`);
    }
  }

  /** Build the PositionState from the DB row. */
  const pos: PositionState = {
    id: row.id,
    orderId: row.order_id,
    pair: row.pair,
    token: row.token,
    tokenName: row.token_name,
    tokenSymbol: row.token_symbol,
    entryPriceUsd: row.entry_price_usd,
    sizeSol: row.size_sol,
    filledSol: row.filled_sol ?? 0,
    avgFillPriceUsd: row.avg_fill_price_usd ?? null,
    peakPriceUsd: row.peak_price_usd,
    trailingActive: row.trailing_active === 1,
    currentProfitPercent: row.current_profit_pct,
    currentProfitUsd: row.current_profit_usd,
    openedAt: row.opened_at,
    expiresAt: row.expires_at ?? row.opened_at + LIVE_CONFIG.baseTtlSecs * 1000,
    lastUpdateAt: row.last_update_at,
    status: row.status as PositionStatus,
    closeReason: row.close_reason as CloseReason | null,
    exitPriceUsd: row.exit_price_usd,
    signal: signal ?? ({} as ParsedSignal),
  };

  /** Query the exchange for the current order state. */
  try {
    const orderInfo = await querySwapOrder(pos.orderId);

    if (!orderInfo) {
      console.warn(
        `[live/core] Recovery: order ${pos.orderId} not found on exchange — keeping as open`,
      );
    } else if (orderInfo.state === "done") {
      pos.entryPriceUsd = orderInfo.txPriceUsd ?? pos.entryPriceUsd;
      pos.status = "closed";
      pos.closeReason = "manual";
      pos.exitPriceUsd = orderInfo.txPriceUsd ?? null;
      console.log(
        `[live/core] Recovery: order ${pos.orderId} is done — marking closed @ $${orderInfo.txPriceUsd}`,
      );
    } else if (orderInfo.state === "fail" || orderInfo.state === "expired") {
      pos.status = "closed";
      pos.closeReason = orderInfo.state === "expired" ? "expired" : "stop_loss";
      console.log(
        `[live/core] Recovery: order ${pos.orderId} is ${orderInfo.state} — marking closed`,
      );
    } else {
      console.log(
        `[live/core] Recovery: order ${pos.orderId} is ${orderInfo.state} — restoring as open`,
      );
    }
  } catch (err) {
    console.warn(
      `[live/core] Recovery: failed to query order ${pos.orderId}: ${err} — restoring as open`,
    );
  }

  /** Update the position ID counter so new positions don't collide. */
  if (pos.id >= nextPositionId) {
    nextPositionId = pos.id + 1;
  }

  /** Store in memory. */
  _positionStore.set(pos.id, pos);
  _latestPositions = _positionStore;
  savePositionToDb(pos);

  /** Emit events for restored positions. */
  if (pos.status === "closed") {
    emitEvent({ type: "closed", position: pos, closeReason: pos.closeReason ?? "manual" });
  } else {
    emitEvent({ type: "opened", position: pos, detail: "Recovered from SQLite" });
  }
}
