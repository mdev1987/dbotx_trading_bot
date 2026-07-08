import { Subject, timer, Observable, Subscription } from "rxjs";
import { filter, map, withLatestFrom, tap } from "rxjs/operators";
import { LIVE_CONFIG } from "./config";
import type { ParsedSignal } from "../telegram/telegram_listener";
import type {
  PositionState,
  PositionEvent,
  CloseReason,
  PositionStatus,
} from "../core/types";
import type { TradeResultEvent } from "./types";
import { PositionStore } from "../core/position-store";
import { SignalQueue } from "../core/signal-queue";
import { LiveExchangeService } from "./services/exchange-service";
import { LivePersistenceService } from "./services/persistence-service";
import { LiveAccountService } from "./services/account-service";
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
import { isPanicMode, enablePanic } from "./panic";
import { markPriceUpdate } from "./watchdog";
import type { DbPositionRow } from "./persistence";

/** PositionStore configuration derived from live config. */
const storeConfig = {
  baseTtlSecs: LIVE_CONFIG.baseTtlSecs,
  pendingBuyTtlMs: LIVE_CONFIG.pendingBuyTtlMs,
  duplicateLockWindowMs: LIVE_CONFIG.duplicateLockWindowMs,
  maxBuysPerMinute: LIVE_CONFIG.maxBuysPerMinute,
  maxBuysPerHour: LIVE_CONFIG.maxBuysPerHour,
  maxConsecutiveApiFailures: LIVE_CONFIG.maxConsecutiveApiFailures,
  dailyLossLimitUsd: LIVE_CONFIG.dailyLossLimitUsd,
  maxTotalSolDeployed: LIVE_CONFIG.maxTotalSolDeployed,
};

/** In-memory store for all open/closed positions. */
const store = new PositionStore(storeConfig);
/** Exchange service handling buy/sell API calls. */
const exchange = new LiveExchangeService();
/** SQLite persistence service for position state. */
const persistence = new LivePersistenceService();
/** Service for computing position sizes and tracking balance. */
const accountService = new LiveAccountService();
/** FIFO queue for incoming trading signals. */
const signalQueue = new SignalQueue(
  LIVE_CONFIG.signalQueueSize,
  LIVE_CONFIG.signalQueueTtlSecs,
);

/**
 * Snapshot of all currently tracked positions (read-only).
 * Kept in sync with the store via the subscription below.
 */
export let _latestPositions: ReadonlyMap<number, PositionState> = store.latestPositions;

// Subscribe to keep _latestPositions updated whenever the store changes
store.openPositions$.subscribe(() => {
  _latestPositions = store.latestPositions;
});

// ── Paper Wallet State ──────────────────────────────────────────────────────

/**
 * Starting capital for the paper wallet (in SOL).
 * This is the virtual balance the bot starts with for paper trading.
 * Increased from the default 5 SOL position size to allow multiple concurrent positions.
 */
const PAPER_STARTING_BALANCE_SOL = 5;

/** Current paper wallet balance (SOL). Starts at PAPER_STARTING_BALANCE_SOL and accrues realized P&L. */
let _paperBalanceSol = PAPER_STARTING_BALANCE_SOL;
/** Cumulative realized P&L across all closed paper positions (SOL). */
let _paperRealizedPnLSol = 0;
/** Count of paper positions that closed with a profit. */
let _paperWins = 0;
/** Count of paper positions that closed with a loss. */
let _paperLosses = 0;

/** Retrieve the current paper wallet balance in SOL. */
export function getPaperBalanceSol(): number {
  return _paperBalanceSol;
}
/** Retrieve the cumulative realized P&L from all closed paper positions (SOL). */
export function getPaperRealizedPnLSol(): number {
  return _paperRealizedPnLSol;
}
/** Retrieve the number of profitable paper trades. */
export function getPaperWins(): number {
  return _paperWins;
}
/** Retrieve the number of losing paper trades. */
export function getPaperLosses(): number {
  return _paperLosses;
}

/** Observable stream of all position events (opened, updated, closed, etc.). */
export const positionEvent$: Observable<PositionEvent> = store.positionEvent$;

/** Observable that emits whenever a new position is opened. */
export const positionOpened$: Observable<PositionState> = store.positionOpened$;

/** Observable that emits whenever a position is closed. */
export const positionClosed$: Observable<PositionState> = store.positionClosed$;

/** Observable that emits the current list of open positions on each change. */
export const openPositions$: Observable<PositionState[]> = store.openPositions$;

/** Look up a position by its exchange order ID. */
export function getPositionByOrderId(orderId: string): PositionState | undefined {
  return store.getByOrderId(orderId);
}

/** Look up a position by its token contract address. */
export function getPositionByToken(token: string): PositionState | undefined {
  return store.getByToken(token);
}

/** Look up a position by its liquidity-pair address. */
export function getPositionByPair(pair: string): PositionState | undefined {
  return store.getByPair(pair);
}

/** Return the number of currently open positions. */
export function countOpenPositions(): number {
  return store.countOpen();
}

/** Manually emit a custom position event into the event stream. */
export function emitEvent(event: PositionEvent): void {
  store.emitEvent(event);
}

/** Apply a partial update to an existing position by its ID. */
export function patchPositionById(
  id: number,
  patch: Partial<PositionState>,
): PositionState | undefined {
  return store.patch(id, patch);
}

/** Transition a position into the "closing" state (prevents double-close). */
export function markPositionClosing(id: number): void {
  store.markClosing(id);
}

/** Mark a position as permanently closed with a given reason and optional exit price. */
export function markPositionClosed(
  id: number,
  reason: CloseReason,
  exitPriceUsd?: number,
): void {
  store.markClosed(id, reason, exitPriceUsd);
}

/** Check whether a buy is already in flight for the given token (prevents duplicates). */
export function hasPendingBuy(token: string): boolean {
  return store.hasPendingBuy(token);
}

/** Record that a buy is in flight for the given token. */
export function addPendingBuy(token: string): void {
  store.addPendingBuy(token);
}

/** Remove the in-flight buy marker for the given token. */
export function removePendingBuy(token: string): void {
  store.removePendingBuy(token);
}

/** Check whether the given liquidity pair is temporarily locked to prevent duplicate buys. */
export function isPairLocked(pair: string): boolean {
  return store.isPairLocked(pair);
}

/** Lock the given liquidity pair for the configured duplicate window. */
export function lockPair(pair: string): void {
  store.lockPair(pair);
}

/** Remove the lock on the given liquidity pair. */
export function unlockPair(pair: string): void {
  store.unlockPair(pair);
}

/** Store the latest known price for a liquidity pair in the in-memory cache. */
export function updatePriceCache(pair: string, priceUsd: number): void {
  store.updatePriceCache(pair, priceUsd);
}

/** Retrieve the most recently cached price for a liquidity pair, if available. */
export function getCachedPrice(pair: string): { priceUsd: number; timestamp: number } | undefined {
  return store.getCachedPrice(pair);
}

/** Return the total SOL currently deployed across all open positions. */
export function totalSolDeployed(): number {
  return store.totalSolDeployed();
}

/** Check whether the per-minute or per-hour buy rate limit has been exceeded. */
export function isBuyRateLimited(): boolean {
  return store.isBuyRateLimited();
}

/** Record the current timestamp as a buy attempt for rate-limit tracking. */
export function recordBuyTimestamp(): void {
  store.recordBuyTimestamp();
}

/** Return the count of consecutive API failures. */
export function consecutiveApiFailures(): number {
  return store.getConsecutiveApiFailures();
}

/** Reset the consecutive API failure counter to zero. */
export function resetApiFailures(): void {
  store.resetApiFailures();
}

/** Increment the consecutive API failure counter and trigger panic mode if the threshold is reached. */
export function incrementApiFailures(): void {
  const count = store.incrementApiFailures();
  if (store.isMaxApiFailuresReached()) {
    console.error(`[live/core] ${count} consecutive API failures — enabling panic`);
    enablePanic();
  }
}

/** Check whether the daily loss limit has been exceeded. */
export function isDailyLossExceeded(): boolean {
  return store.isDailyLossExceeded();
}

/** Record a P&L value (negative = loss) toward the daily loss tracker. */
export function recordDailyLoss(pnlUsd: number): void {
  store.recordDailyLoss(pnlUsd);
}

/** Load the persisted daily loss value from SQLite into the in-memory store. */
export function loadDailyLossFromDb(): void {
  const loss = persistence.loadDailyLoss();
  store.setDailyLoss(loss);
}

/** Reset the daily loss counter both in memory and in SQLite. */
export function resetDailyLoss(): void {
  store.setDailyLoss(0);
  persistence.resetDailyLoss();
}

// ── Open Position ───────────────────────────────────────────────────────────

/**
 * Attempt to open a new position for the given trading signal.
 * Runs all pre-flight checks (panic, rate limits, daily loss, duplicate detection),
 * executes the buy via the exchange, and kicks off entry-price capture.
 * Returns the new position ID on success, or 0 if rejected/failed.
 */
export async function openPosition(signal: ParsedSignal): Promise<number> {
  // Paper mode: create a virtual position without calling the exchange
  if (!LIVE_CONFIG.liveBuyEnabled) {
    console.log("[live/core] LIVE_BUY_ENABLED is false — opening paper position");

    // Simple dedup checks for paper mode
    const existingPaper = store.getByToken(signal.contractAddress);
    if (existingPaper && existingPaper.status !== "closed") return 0;
    if (store.hasPendingBuy(signal.contractAddress)) return 0;
    if (store.isPairLocked(signal.lpAddress)) return 0;

    const cachedPrice = store.getCachedPrice(signal.lpAddress);
    const entryPriceUsd = cachedPrice?.priceUsd && cachedPrice.priceUsd > 0
      ? cachedPrice.priceUsd
      : null;

    const paperId = store.generateId();
    const paperOrderId = `paper_${paperId}_${Date.now()}`;
    const paperSize = accountService.computePositionSize(signal);

    // Check paper balance has enough capital for this position
    if (_paperBalanceSol < paperSize) {
      console.warn(`[live/core] Paper balance too low (${_paperBalanceSol.toFixed(2)} SOL) for ${paperSize.toFixed(4)} SOL position`);
      return 0;
    }

    const position: PositionState = {
      id: paperId,
      orderId: paperOrderId,
      pair: signal.lpAddress,
      token: signal.contractAddress,
      tokenName: signal.tokenName ?? "",
      tokenSymbol: "",
      entryPriceUsd,
      entryCostUsd: null,
      sizeSol: paperSize,
      filledSol: paperSize,
      avgFillPriceUsd: null,
      peakPriceUsd: entryPriceUsd ?? 0,
      trailingActive: false,
      tasks: new Map(),
      currentProfitPercent: 0,
      currentProfitUsd: 0,
      remainingBalance: "0",
      openedAt: Date.now(),
      expiresAt: Date.now() + LIVE_CONFIG.baseTtlSecs * 1000,
      lastUpdateAt: Date.now(),
      status: "open",
      closeReason: null,
      exitPriceUsd: null,
      signal,
    };

    store.set(position);
    store.addExposure(paperSize);
    persistence.savePosition(position);
    store.emitEvent({ type: "opened", position, detail: "paper" });
    store.recordBuyTimestamp();
    _paperBalanceSol -= paperSize;
    accountService.refreshBalance();
    return paperId;
  }

  // Reject if global panic mode is active (e.g. too many API failures)
  if (isPanicMode()) {
    console.warn("[live/core] Panic mode active — rejecting new position");
    return 0;
  }

  // Reject if the daily loss budget has been exhausted
  if (store.isDailyLossExceeded()) {
    console.warn(`[live/core] Daily loss limit exceeded — rejecting new position`);
    return 0;
  }

  // Reject if per-minute or per-hour buy rate cap is hit
  if (store.isBuyRateLimited()) {
    console.warn("[live/core] Buy rate limit exceeded — rejecting new position");
    return 0;
  }

  // Reject if the total SOL deployed across all positions would exceed the configured max
  if (LIVE_CONFIG.maxTotalSolDeployed > 0 && store.totalSolDeployed() >= LIVE_CONFIG.maxTotalSolDeployed) {
    console.warn(`[live/core] Max total SOL deployed reached — rejecting new position`);
    return 0;
  }

  // Reject if this token already has a non-closed position
  const existing = store.getByToken(signal.contractAddress);
  if (existing && existing.status !== "closed") {
    return 0;
  }

  // Reject if a buy for this token is already in flight
  if (store.hasPendingBuy(signal.contractAddress)) {
    return 0;
  }

  // Reject if this pair is inside the duplicate-lock window
  if (store.isPairLocked(signal.lpAddress)) {
    return 0;
  }

  // Reject if the cached price signals a broken/zero-price pair
  const cached = store.getCachedPrice(signal.lpAddress);
  if (cached && LIVE_CONFIG.maxPriceDeviationPct > 0 && cached.priceUsd <= 0) {
    console.warn(`[live/core] Cached price for ${signal.tokenName} is ${cached.priceUsd} — aborting`);
    return 0;
  }

  // Reject if the cooldown period between consecutive buys is still active
  if (store.checkCooldown()) {
    console.log(`[live/core] Cooldown active (${Math.ceil(store.remainingCooldownMs() / 1000)}s) — skipping`);
    return 0;
  }

  // Compute the position size in SOL based on the signal and current balance
  const sizeSol = accountService.computePositionSize(signal);

  // Reserve this token/pair to prevent concurrent buys
  store.addPendingBuy(signal.contractAddress);
  store.lockPair(signal.lpAddress);

  // Execute the buy order and set up the new position
  try {
    // Place the buy order on the exchange
    const orderId = await exchange.buy(signal.lpAddress, sizeSol, signal);
    // Successful API call — reset consecutive failure counter
    store.resetApiFailures();

    // Build the initial position state object
    const position: PositionState = {
      id: store.generateId(),
      orderId,
      pair: signal.lpAddress,
      token: signal.contractAddress,
      tokenName: signal.tokenName ?? "",
      tokenSymbol: "",
      entryPriceUsd: null,
      entryCostUsd: null,
      sizeSol,
      filledSol: 0,
      avgFillPriceUsd: null,
      peakPriceUsd: 0,
      trailingActive: false,
      tasks: new Map(),
      currentProfitPercent: 0,
      currentProfitUsd: 0,
      remainingBalance: "0",
      openedAt: Date.now(),
      expiresAt: Date.now() + LIVE_CONFIG.baseTtlSecs * 1000,
      lastUpdateAt: Date.now(),
      status: "open",
      closeReason: null,
      exitPriceUsd: null,
      signal,
    };

    // Register the position in the store, exposure tracker, and persistence
    store.set(position);
    store.addExposure(sizeSol);
    persistence.savePosition(position);
    store.emitEvent({ type: "opened", position });
    store.recordBuyTimestamp();
    // Fire-and-forget balance refresh so subsequent positions use updated numbers
    accountService.refreshBalance();

    // Poll the exchange asynchronously to get the actual fill price
    captureEntryPrice(position.id, orderId).catch((err) => {
      console.error(`[live/core] Failed to capture entry price for position ${position.id}:`, err);
    });

    return position.id;
  } catch (err) {
    // Clean up the pending-buy / lock markers on failure
    store.removePendingBuy(signal.contractAddress);
    incrementApiFailures();
    console.error(`[live/core] Failed to open position for ${signal.tokenName}:`, err);
    return 0;
  }
}

// ── Entry Price Capture ─────────────────────────────────────────────────────

/**
 * Poll the exchange until the buy order is fully settled, then patch the position
 * with the actual entry price. Always removes the pending-buy marker when done.
 */
async function captureEntryPrice(
  positionId: number,
  orderId: string,
): Promise<void> {
  try {
    // Poll the exchange until the order is confirmed (or timeout)
    const orderInfo = await exchange.pollUntilDone(orderId);

    // Update the position with the actual fill price from the chain
    if (orderInfo.txPriceUsd && orderInfo.txPriceUsd > 0) {
      store.patch(positionId, {
        entryPriceUsd: orderInfo.txPriceUsd,
        peakPriceUsd: orderInfo.txPriceUsd,
      });
    }

    // Remove the in-flight buy marker regardless of whether a price was obtained
    const token = store.get(positionId)?.token;
    if (token) store.removePendingBuy(token);
  } catch (err) {
    // Ensure the pending-buy marker is always cleaned up, even on failure
    const token = store.get(positionId)?.token;
    if (token) store.removePendingBuy(token);
  }
}

// ── Close Position ──────────────────────────────────────────────────────────

/**
 * Close an open position by its ID. Places a sell order on the exchange,
 * then schedules a fallback poll to confirm the fill.
 * An optional callback receives the exchange sell-order ID.
 */
export async function closePositionById(
  id: number,
  reason: CloseReason,
  cb?: (sellOrderId: string) => void,
): Promise<void> {
  // Look up the position and bail if already closed or closing
  const pos = store.get(id);
  if (!pos || pos.status === "closed" || pos.status === "closing") return;

  // Paper positions use a fake "paper_" order ID — skip the exchange sell
  if (pos.orderId.startsWith("paper_")) {
    store.markClosing(id);
    const cached = store.getCachedPrice(pos.pair);
    const exitPrice = cached?.priceUsd && cached.priceUsd > 0
      ? cached.priceUsd
      : pos.entryPriceUsd ?? undefined;
    store.markClosed(id, reason, exitPrice ?? undefined);
    handlePositionClosed(id);

    // Update paper wallet stats
    const closed = store.get(id);
    if (closed) {
      const pnlSol = closed.currentProfitPercent * closed.sizeSol;
      _paperBalanceSol += closed.sizeSol + pnlSol;
      _paperRealizedPnLSol += pnlSol;
      if (pnlSol >= 0) _paperWins++;
      else _paperLosses++;
    }

    if (cb) cb(`paper_sell_${id}_${Date.now()}`);
    return;
  }

  // Transition to "closing" to prevent concurrent close attempts
  store.markClosing(id);

  try {
    // Submit the sell order to the exchange
    const sellOrderId = await exchange.sell(pos.pair);

    // Notify the caller with the sell order ID (e.g. for external tracking)
    if (cb) cb(sellOrderId);

    // Start a background timer to poll for sell completion
    scheduleSellFallback(id, sellOrderId, reason);
  } catch (err) {
    // On sell failure, revert to "open" and increment the API failure counter
    incrementApiFailures();
    pos.status = "open";
    pos.lastUpdateAt = Date.now();
    persistence.savePosition(pos);
    store.emitEvent({ type: "updated", position: pos, detail: `Sell failed: ${err}` });
  }
}

/**
 * Schedule a one-shot poll of the sell order 30 seconds after the sell was placed.
 * If the order fills during that window, the position is marked closed.
 * Acts as a fallback in case the WebSocket event is missed.
 */
function scheduleSellFallback(
  positionId: number,
  sellOrderId: string,
  reason: CloseReason,
): void {
  setTimeout(async () => {
    const pos = store.get(positionId);
    // Bail if the position was already closed by another path (e.g. WS event)
    if (!pos || pos.status === "closed") return;

    try {
      // Poll the exchange up to 10 times with a 3-second interval
      const orderInfo = await exchange.pollUntilDone(sellOrderId, 10, 3_000);
      store.markClosed(positionId, reason, orderInfo.txPriceUsd);
      handlePositionClosed(positionId);
    } catch (err) {
      console.error(`[live/core] Fallback sell poll failed for ${sellOrderId}:`, err);
    }
  }, 30_000);
}

// ── WS Trade Events ────────────────────────────────────────────────────────

/**
 * Subscribe to all WebSocket trade-result events and wire them to the position store.
 * Handles buy confirmations, sell completions, TP/SL hits, and trade failures.
 * Returns a Subscription that should be unsubscribed on shutdown.
 */
export function subscribeToTradeEvents(): Subscription {
  const subs = new Subscription();

  // Handle buy-success: patch entry price and clear pending-buy marker
  subs.add(
    buySuccessEvent$.subscribe((event) => {
      const pos = store.getByOrderId(event.result.id);
      if (!pos) return;
      // Only update if we haven't already captured the entry price
      if (!pos.entryPriceUsd && event.result.priceUsd) {
        store.patch(pos.id, {
          entryPriceUsd: event.result.priceUsd,
          peakPriceUsd: event.result.priceUsd,
        });
        store.removePendingBuy(pos.token);
      }
    }),
  );

  // Handle manual sell success: mark position as closed
  subs.add(
    sellSuccessEvent$.subscribe((event) => {
      const pos = store.getByOrderId(event.result.id);
      if (!pos) return;
      store.markClosed(pos.id, "manual", event.result.priceUsd);
      handlePositionClosed(pos.id);
    }),
  );

  // Handle take-profit fill: mark position as closed
  subs.add(
    takeProfitSuccessEvent$.subscribe((event) => {
      const pos = store.getByOrderId(event.result.id);
      if (!pos) return;
      store.markClosed(pos.id, "take_profit", event.result.priceUsd);
      handlePositionClosed(pos.id);
    }),
  );

  // Handle stop-loss fill: mark position as closed
  subs.add(
    stopLossSuccessEvent$.subscribe((event) => {
      const pos = store.getByOrderId(event.result.id);
      if (!pos) return;
      store.markClosed(pos.id, "stop_loss", event.result.priceUsd);
      handlePositionClosed(pos.id);
    }),
  );

  // Handle trailing-stop fill: mark position as closed
  subs.add(
    trailingStopSuccessEvent$.subscribe((event) => {
      const pos = store.getByOrderId(event.result.id);
      if (!pos) return;
      store.markClosed(pos.id, "trailing_stop", event.result.priceUsd);
      handlePositionClosed(pos.id);
    }),
  );

  // Handle trade failure: log the error for diagnostics
  subs.add(
    tradeFailEvent$.subscribe((event) => {
      const pos = store.getByOrderId(event.result.id);
      const tokenName = pos?.tokenName ?? event.result.symbol;
      console.error(`[live/core] WS: Trade FAILED for ${tokenName}`);
    }),
  );

  return subs;
}

/**
 * Post-close bookkeeping: record losses, release exposure, and persist the closed state.
 */
function handlePositionClosed(id: number): void {
  // Look up the position; bail if it has already been removed
  const pos = store.get(id);
  if (!pos) return;

  // Track negative P&L as a loss event for statistical reporting
  if (pos.currentProfitPercent < 0) {
    store.recordLoss(pos.currentProfitPercent);
  }

  // Deduct negative USD from the daily loss budget and persist to SQLite
  if (pos.currentProfitUsd < 0) {
    store.recordDailyLoss(pos.currentProfitUsd);
    persistence.saveDailyLoss(store.getDailyLoss());
  }

  // Free up the SOL that was allocated to this position
  store.releaseExposure(pos.sizeSol);
  // Persist the final position state (status = closed)
  persistence.savePosition(pos);
}

// ── TTL Expiry Checker ──────────────────────────────────────────────────────

/**
 * Start a periodically-firing timer that checks all open positions for TTL expiry.
 * Positions that exceed the per-position TTL or the global hard-cap TTL are closed.
 * Returns a Subscription that should be unsubscribed on shutdown.
 */
export function startTtlChecker(): Subscription {
  const { baseTtlSecs, maxTtlSecs, expiryCheckMs } = LIVE_CONFIG;

  // Poll on a fixed interval (e.g. every 10 s) defined by the config
  return timer(expiryCheckMs, expiryCheckMs)
    .pipe(
      // Pair the timer tick with the most recent snapshot of open positions
      withLatestFrom(store.openPositions$),
      tap(([, positions]) => {
        const now = Date.now();

        for (const pos of positions) {
          // Skip positions that are already closing/closed or don't have an entry price yet
          if (pos.status !== "open" || !pos.entryPriceUsd) continue;

          const age = now - pos.openedAt;
          const maxAge = maxTtlSecs * 1000;

          // Enforce the absolute maximum lifetime for any position (hard cap)
          if (maxTtlSecs > 0 && age >= maxAge) {
            closePositionById(pos.id, "expired").catch((err) => {
              console.error(`[live/core] TTL hard cap close failed:`, err);
            });
            continue;
          }

          // Enforce the per-position TTL (baseTtlSecs adjusted by the signal's score multiplier)
          if (now >= pos.expiresAt) {
            closePositionById(pos.id, "expired").catch((err) => {
              console.error(`[live/core] TTL close failed:`, err);
            });
          }
        }
      }),
    )
    .subscribe();
}

// ── Price Updates ───────────────────────────────────────────────────────────

/**
 * Subscribe to live price feed updates and apply them to all relevant open positions.
 * Updates peak price, unrealised P&L, and the in-memory price cache.
 * Returns a Subscription that should be unsubscribed on shutdown.
 */
export function subscribeToPriceUpdates(): Subscription {
  return pairUpdate$
    .pipe(
      // Merge each price tick with the current snapshot of open positions
      withLatestFrom(store.openPositions$),
      tap(([update, positions]) => {
        // Skip invalid or zero-price updates
        if (update.priceUsd == null || update.priceUsd <= 0) return;
        // Notify the watchdog that we received a fresh price tick
        markPriceUpdate();
        // Store the latest price in the cache for pre-flight checks
        store.updatePriceCache(update.pair, update.priceUsd);

        for (const pos of positions) {
          // Skip positions that don't match this pair or haven't captured entry price yet
          if (pos.pair !== update.pair || !pos.entryPriceUsd) continue;
          const currentPrice = update.priceUsd;
          if (!currentPrice || currentPrice <= 0) continue;

          // Update the all-time peak price for trailing stop calculation
          if (currentPrice > pos.peakPriceUsd) {
            pos.peakPriceUsd = currentPrice;
          }

          // Compute unrealised profit as a fraction of entry price and in USD terms
          pos.currentProfitPercent = (currentPrice - pos.entryPriceUsd) / pos.entryPriceUsd;
          pos.currentProfitUsd = pos.currentProfitPercent * pos.sizeSol;
          pos.lastUpdateAt = Date.now();
        }
      }),
    )
    .subscribe();
}

// ── Signal Queue ────────────────────────────────────────────────────────────

/** Push a trading signal onto the FIFO queue for later processing. */
export function enqueueSignal(signal: ParsedSignal): void {
  signalQueue.enqueue(signal);
}

/** Pop the oldest signal from the front of the FIFO queue (or null if empty). */
export function dequeueSignal(): ParsedSignal | null {
  return signalQueue.dequeue();
}

/** Return the current number of signals waiting in the queue. */
export function queueLength(): number {
  return signalQueue.length;
}

/** Clear all queued signals (intended for test teardown only). */
export function _clearQueueForTest(): void {
  signalQueue.clear();
}

// ── Recovery ────────────────────────────────────────────────────────────────

/**
 * On startup, reload non-closed positions from SQLite so the bot can resume monitoring them.
 * Re-emits the appropriate position events so downstream consumers stay in sync.
 */
export async function recoverOpenPositions(): Promise<void> {
  // Bail early if recovery is disabled in the live config
  if (!LIVE_CONFIG.recoveryOnStart) {
    console.log("[live/core] Recovery on startup disabled — skipping");
    return;
  }

  console.log("[live/core] Recovery: loading positions from SQLite...");

  try {
    // Load all positions that are not in "closed" status
    const positions = await persistence.loadNonClosed();
    if (positions.length === 0) {
      console.log("[live/core] Recovery: no non-closed positions found");
      return;
    }

    for (const pos of positions) {
      // Ensure the store's auto-increment counter doesn't collide with recovered IDs
      store.syncIdCounter(pos.id);
      // Register the position in the in-memory store
      store.set(pos);
      // Re-persist to ensure the SQLite row is up to date
      persistence.savePosition(pos);

      // Re-emit the appropriate event so subscribers (e.g. UI) reflect the recovered state
      if (pos.status === "closed") {
        store.emitEvent({ type: "closed", position: pos, closeReason: pos.closeReason ?? "manual" });
      } else {
        store.emitEvent({ type: "opened", position: pos, detail: "Recovered from SQLite" });
      }
    }
  } catch (err) {
    console.error("[live/core] Recovery failed:", err);
  }
}
