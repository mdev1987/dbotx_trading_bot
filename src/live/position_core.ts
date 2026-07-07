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

// ── Internal services ───────────────────────────────────────────────────────

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

const store = new PositionStore(storeConfig);
const exchange = new LiveExchangeService();
const persistence = new LivePersistenceService();
const accountService = new LiveAccountService();
const signalQueue = new SignalQueue(
  LIVE_CONFIG.signalQueueSize,
  LIVE_CONFIG.signalQueueTtlSecs,
);

// ── Position Store Re-exports ───────────────────────────────────────────────

export let _latestPositions: ReadonlyMap<number, PositionState> = store.latestPositions;

// Keep _latestPositions in sync with store
store.openPositions$.subscribe(() => {
  _latestPositions = store.latestPositions;
});

export const positionEvent$: Observable<PositionEvent> = store.positionEvent$;

export const positionOpened$: Observable<PositionState> = store.positionOpened$;

export const positionClosed$: Observable<PositionState> = store.positionClosed$;

export const openPositions$: Observable<PositionState[]> = store.openPositions$;

export function getPositionByOrderId(orderId: string): PositionState | undefined {
  return store.getByOrderId(orderId);
}

export function getPositionByToken(token: string): PositionState | undefined {
  return store.getByToken(token);
}

export function getPositionByPair(pair: string): PositionState | undefined {
  return store.getByPair(pair);
}

export function countOpenPositions(): number {
  return store.countOpen();
}

export function emitEvent(event: PositionEvent): void {
  store.emitEvent(event);
}

export function patchPositionById(
  id: number,
  patch: Partial<PositionState>,
): PositionState | undefined {
  return store.patch(id, patch);
}

export function markPositionClosing(id: number): void {
  store.markClosing(id);
}

export function markPositionClosed(
  id: number,
  reason: CloseReason,
  exitPriceUsd?: number,
): void {
  store.markClosed(id, reason, exitPriceUsd);
}

// ── Pending Buy Dedup ───────────────────────────────────────────────────────

export function hasPendingBuy(token: string): boolean {
  return store.hasPendingBuy(token);
}

export function addPendingBuy(token: string): void {
  store.addPendingBuy(token);
}

export function removePendingBuy(token: string): void {
  store.removePendingBuy(token);
}

// ── Pair+Timestamp Duplicate Lock ───────────────────────────────────────────

export function isPairLocked(pair: string): boolean {
  return store.isPairLocked(pair);
}

export function lockPair(pair: string): void {
  store.lockPair(pair);
}

export function unlockPair(pair: string): void {
  store.unlockPair(pair);
}

// ── Price Cache ─────────────────────────────────────────────────────────────

export function updatePriceCache(pair: string, priceUsd: number): void {
  store.updatePriceCache(pair, priceUsd);
}

export function getCachedPrice(pair: string): { priceUsd: number; timestamp: number } | undefined {
  return store.getCachedPrice(pair);
}

// ── Exposure Tracking ───────────────────────────────────────────────────────

export function totalSolDeployed(): number {
  return store.totalSolDeployed();
}

// ── Rate Limiting ───────────────────────────────────────────────────────────

export function isBuyRateLimited(): boolean {
  return store.isBuyRateLimited();
}

export function recordBuyTimestamp(): void {
  store.recordBuyTimestamp();
}

// ── Consecutive API Failures ────────────────────────────────────────────────

export function consecutiveApiFailures(): number {
  return store.getConsecutiveApiFailures();
}

export function resetApiFailures(): void {
  store.resetApiFailures();
}

export function incrementApiFailures(): void {
  const count = store.incrementApiFailures();
  if (store.isMaxApiFailuresReached()) {
    console.error(`[live/core] ${count} consecutive API failures — enabling panic`);
    enablePanic();
  }
}

// ── Daily Loss Tracking ─────────────────────────────────────────────────────

export function isDailyLossExceeded(): boolean {
  return store.isDailyLossExceeded();
}

export function recordDailyLoss(pnlUsd: number): void {
  store.recordDailyLoss(pnlUsd);
}

export function loadDailyLossFromDb(): void {
  const loss = persistence.loadDailyLoss();
  store.setDailyLoss(loss);
}

export function resetDailyLoss(): void {
  store.setDailyLoss(0);
  persistence.resetDailyLoss();
}

// ── Open Position ───────────────────────────────────────────────────────────

export async function openPosition(signal: ParsedSignal): Promise<number> {
  if (!LIVE_CONFIG.liveBuyEnabled) {
    console.warn("[live/core] LIVE_BUY_ENABLED is false — rejecting new position");
    return 0;
  }

  if (isPanicMode()) {
    console.warn("[live/core] Panic mode active — rejecting new position");
    return 0;
  }

  if (store.isDailyLossExceeded()) {
    console.warn(`[live/core] Daily loss limit exceeded — rejecting new position`);
    return 0;
  }

  if (store.isBuyRateLimited()) {
    console.warn("[live/core] Buy rate limit exceeded — rejecting new position");
    return 0;
  }

  if (LIVE_CONFIG.maxTotalSolDeployed > 0 && store.totalSolDeployed() >= LIVE_CONFIG.maxTotalSolDeployed) {
    console.warn(`[live/core] Max total SOL deployed reached — rejecting new position`);
    return 0;
  }

  const existing = store.getByToken(signal.contractAddress);
  if (existing && existing.status !== "closed") {
    return 0;
  }

  if (store.hasPendingBuy(signal.contractAddress)) {
    return 0;
  }

  if (store.isPairLocked(signal.lpAddress)) {
    return 0;
  }

  const cached = store.getCachedPrice(signal.lpAddress);
  if (cached && LIVE_CONFIG.maxPriceDeviationPct > 0 && cached.priceUsd <= 0) {
    console.warn(`[live/core] Cached price for ${signal.tokenName} is ${cached.priceUsd} — aborting`);
    return 0;
  }

  if (store.checkCooldown()) {
    console.log(`[live/core] Cooldown active (${Math.ceil(store.remainingCooldownMs() / 1000)}s) — skipping`);
    return 0;
  }

  const sizeSol = accountService.computePositionSize(signal);

  store.addPendingBuy(signal.contractAddress);
  store.lockPair(signal.lpAddress);

  try {
    const orderId = await exchange.buy(signal.lpAddress, sizeSol, signal);
    store.resetApiFailures();

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

    store.set(position);
    store.addExposure(sizeSol);
    persistence.savePosition(position);
    store.emitEvent({ type: "opened", position });
    store.recordBuyTimestamp();
    accountService.refreshBalance();

    captureEntryPrice(position.id, orderId).catch((err) => {
      console.error(`[live/core] Failed to capture entry price for position ${position.id}:`, err);
    });

    return position.id;
  } catch (err) {
    store.removePendingBuy(signal.contractAddress);
    incrementApiFailures();
    console.error(`[live/core] Failed to open position for ${signal.tokenName}:`, err);
    return 0;
  }
}

// ── Entry Price Capture ─────────────────────────────────────────────────────

async function captureEntryPrice(
  positionId: number,
  orderId: string,
): Promise<void> {
  try {
    const orderInfo = await exchange.pollUntilDone(orderId);

    if (orderInfo.txPriceUsd && orderInfo.txPriceUsd > 0) {
      store.patch(positionId, {
        entryPriceUsd: orderInfo.txPriceUsd,
        peakPriceUsd: orderInfo.txPriceUsd,
      });
    }

    const token = store.get(positionId)?.token;
    if (token) store.removePendingBuy(token);
  } catch (err) {
    const token = store.get(positionId)?.token;
    if (token) store.removePendingBuy(token);
  }
}

// ── Close Position ──────────────────────────────────────────────────────────

export async function closePositionById(
  id: number,
  reason: CloseReason,
  cb?: (sellOrderId: string) => void,
): Promise<void> {
  const pos = store.get(id);
  if (!pos || pos.status === "closed" || pos.status === "closing") return;

  store.markClosing(id);

  try {
    const sellOrderId = await exchange.sell(pos.pair);

    if (cb) cb(sellOrderId);

    scheduleSellFallback(id, sellOrderId, reason);
  } catch (err) {
    incrementApiFailures();
    pos.status = "open";
    pos.lastUpdateAt = Date.now();
    persistence.savePosition(pos);
    store.emitEvent({ type: "updated", position: pos, detail: `Sell failed: ${err}` });
  }
}

function scheduleSellFallback(
  positionId: number,
  sellOrderId: string,
  reason: CloseReason,
): void {
  setTimeout(async () => {
    const pos = store.get(positionId);
    if (!pos || pos.status === "closed") return;

    try {
      const orderInfo = await exchange.pollUntilDone(sellOrderId, 10, 3_000);
      store.markClosed(positionId, reason, orderInfo.txPriceUsd);
      handlePositionClosed(positionId);
    } catch (err) {
      console.error(`[live/core] Fallback sell poll failed for ${sellOrderId}:`, err);
    }
  }, 30_000);
}

// ── WS Trade Events ────────────────────────────────────────────────────────

export function subscribeToTradeEvents(): Subscription {
  const subs = new Subscription();

  subs.add(
    buySuccessEvent$.subscribe((event) => {
      const pos = store.getByOrderId(event.result.id);
      if (!pos) return;
      if (!pos.entryPriceUsd && event.result.priceUsd) {
        store.patch(pos.id, {
          entryPriceUsd: event.result.priceUsd,
          peakPriceUsd: event.result.priceUsd,
        });
        store.removePendingBuy(pos.token);
      }
    }),
  );

  subs.add(
    sellSuccessEvent$.subscribe((event) => {
      const pos = store.getByOrderId(event.result.id);
      if (!pos) return;
      store.markClosed(pos.id, "manual", event.result.priceUsd);
      handlePositionClosed(pos.id);
    }),
  );

  subs.add(
    takeProfitSuccessEvent$.subscribe((event) => {
      const pos = store.getByOrderId(event.result.id);
      if (!pos) return;
      store.markClosed(pos.id, "take_profit", event.result.priceUsd);
      handlePositionClosed(pos.id);
    }),
  );

  subs.add(
    stopLossSuccessEvent$.subscribe((event) => {
      const pos = store.getByOrderId(event.result.id);
      if (!pos) return;
      store.markClosed(pos.id, "stop_loss", event.result.priceUsd);
      handlePositionClosed(pos.id);
    }),
  );

  subs.add(
    trailingStopSuccessEvent$.subscribe((event) => {
      const pos = store.getByOrderId(event.result.id);
      if (!pos) return;
      store.markClosed(pos.id, "trailing_stop", event.result.priceUsd);
      handlePositionClosed(pos.id);
    }),
  );

  subs.add(
    tradeFailEvent$.subscribe((event) => {
      const pos = store.getByOrderId(event.result.id);
      const tokenName = pos?.tokenName ?? event.result.symbol;
      console.error(`[live/core] WS: Trade FAILED for ${tokenName}`);
    }),
  );

  return subs;
}

function handlePositionClosed(id: number): void {
  const pos = store.get(id);
  if (!pos) return;

  if (pos.currentProfitPercent < 0) {
    store.recordLoss(pos.currentProfitPercent);
  }

  if (pos.currentProfitUsd < 0) {
    store.recordDailyLoss(pos.currentProfitUsd);
    persistence.saveDailyLoss(store.getDailyLoss());
  }

  store.releaseExposure(pos.sizeSol);
  persistence.savePosition(pos);
}

// ── TTL Expiry Checker ──────────────────────────────────────────────────────

export function startTtlChecker(): Subscription {
  const { baseTtlSecs, maxTtlSecs, expiryCheckMs } = LIVE_CONFIG;

  return timer(expiryCheckMs, expiryCheckMs)
    .pipe(
      withLatestFrom(store.openPositions$),
      tap(([, positions]) => {
        const now = Date.now();

        for (const pos of positions) {
          if (pos.status !== "open" || !pos.entryPriceUsd) continue;

          const age = now - pos.openedAt;
          const maxAge = maxTtlSecs * 1000;

          if (maxTtlSecs > 0 && age >= maxAge) {
            closePositionById(pos.id, "expired").catch((err) => {
              console.error(`[live/core] TTL hard cap close failed:`, err);
            });
            continue;
          }

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

export function subscribeToPriceUpdates(): Subscription {
  return pairUpdate$
    .pipe(
      withLatestFrom(store.openPositions$),
      tap(([update, positions]) => {
        if (update.priceUsd == null || update.priceUsd <= 0) return;
        markPriceUpdate();
        store.updatePriceCache(update.pair, update.priceUsd);

        for (const pos of positions) {
          if (pos.pair !== update.pair || !pos.entryPriceUsd) continue;
          const currentPrice = update.priceUsd;
          if (!currentPrice || currentPrice <= 0) continue;

          if (currentPrice > pos.peakPriceUsd) {
            pos.peakPriceUsd = currentPrice;
          }

          pos.currentProfitPercent = (currentPrice - pos.entryPriceUsd) / pos.entryPriceUsd;
          pos.currentProfitUsd = pos.currentProfitPercent * pos.sizeSol;
          pos.lastUpdateAt = Date.now();
        }
      }),
    )
    .subscribe();
}

// ── Signal Queue ────────────────────────────────────────────────────────────

export function enqueueSignal(signal: ParsedSignal): void {
  signalQueue.enqueue(signal);
}

export function dequeueSignal(): ParsedSignal | null {
  return signalQueue.dequeue();
}

export function queueLength(): number {
  return signalQueue.length;
}

export function _clearQueueForTest(): void {
  signalQueue.clear();
}

// ── Recovery ────────────────────────────────────────────────────────────────

export async function recoverOpenPositions(): Promise<void> {
  if (!LIVE_CONFIG.recoveryOnStart) {
    console.log("[live/core] Recovery on startup disabled — skipping");
    return;
  }

  console.log("[live/core] Recovery: loading positions from SQLite...");

  try {
    const positions = await persistence.loadNonClosed();
    if (positions.length === 0) {
      console.log("[live/core] Recovery: no non-closed positions found");
      return;
    }

    for (const pos of positions) {
      store.syncIdCounter(pos.id);
      store.set(pos);
      persistence.savePosition(pos);

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
