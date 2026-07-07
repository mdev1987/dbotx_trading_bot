import { Subject, Observable, BehaviorSubject } from "rxjs";
import { filter, map, share } from "rxjs/operators";
import type { PositionState, PositionEvent, CloseReason } from "./types";

export interface PositionStoreConfig {
  baseTtlSecs: number;
  pendingBuyTtlMs: number;
  duplicateLockWindowMs: number;
  maxBuysPerMinute: number;
  maxBuysPerHour: number;
  maxConsecutiveApiFailures: number;
  dailyLossLimitUsd: number;
  maxTotalSolDeployed: number;
  cooldownDurationMs?: number;
  cooldownThreshold?: number;
}

export class PositionStore {
  protected readonly store = new Map<number, PositionState>();
  protected nextPositionId = 1;

  protected readonly positionEventSubject = new Subject<PositionEvent>();
  readonly positionEvent$: Observable<PositionEvent> = this.positionEventSubject.pipe(share());

  readonly positionOpened$: Observable<PositionState> = this.positionEvent$.pipe(
    filter((e): e is PositionEvent & { type: "opened" } => e.type === "opened"),
    map((e) => e.position),
  );

  readonly positionClosed$: Observable<PositionState> = this.positionEvent$.pipe(
    filter((e): e is PositionEvent & { type: "closed" } => e.type === "closed"),
    map((e) => e.position),
  );

  readonly openPositions$: Observable<PositionState[]> = this.positionEvent$.pipe(
    map(() => {
      const open: PositionState[] = [];
      for (const pos of this.store.values()) {
        if (pos.status === "open" || pos.status === "closing") open.push(pos);
      }
      return open;
    }),
  );

  protected _latestPositions: ReadonlyMap<number, PositionState> = this.store;

  constructor(protected readonly config: PositionStoreConfig) {}

  get latestPositions(): ReadonlyMap<number, PositionState> {
    return this._latestPositions;
  }

  generateId(): number {
    return this.nextPositionId++;
  }

  syncIdCounter(id: number): void {
    if (id >= this.nextPositionId) {
      this.nextPositionId = id + 1;
    }
  }

  get(id: number): PositionState | undefined {
    return this.store.get(id);
  }

  getByOrderId(orderId: string): PositionState | undefined {
    for (const pos of this.store.values()) {
      if (pos.orderId === orderId) return pos;
    }
    return undefined;
  }

  getByToken(token: string): PositionState | undefined {
    for (const pos of this.store.values()) {
      if (pos.token === token && pos.status !== "closed") return pos;
    }
    return undefined;
  }

  getByPair(pair: string): PositionState | undefined {
    for (const pos of this.store.values()) {
      if (pos.pair === pair && pos.status !== "closed") return pos;
    }
    return undefined;
  }

  countOpen(): number {
    let count = 0;
    for (const pos of this.store.values()) {
      if (pos.status === "open" || pos.status === "closing") count++;
    }
    return count;
  }

  set(position: PositionState): void {
    this.store.set(position.id, position);
    this._latestPositions = this.store;
  }

  patch(id: number, patch: Partial<PositionState>): PositionState | undefined {
    const pos = this.store.get(id);
    if (!pos) return undefined;
    Object.assign(pos, patch, { lastUpdateAt: Date.now() });
    this.emitEvent({ type: "updated", position: pos });
    return pos;
  }

  markClosing(id: number): void {
    const pos = this.store.get(id);
    if (!pos || pos.status !== "open") return;
    pos.status = "closing";
    pos.lastUpdateAt = Date.now();
    this.emitEvent({ type: "closing", position: pos });
  }

  markClosed(id: number, reason: CloseReason, exitPriceUsd?: number): void {
    const pos = this.store.get(id);
    if (!pos || pos.status === "closed") return;
    pos.status = "closed";
    pos.closeReason = reason;
    pos.exitPriceUsd = exitPriceUsd ?? pos.exitPriceUsd;
    pos.lastUpdateAt = Date.now();
    if (pos.entryPriceUsd && exitPriceUsd) {
      pos.currentProfitPercent = (exitPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd;
      pos.currentProfitUsd = pos.currentProfitPercent * pos.sizeSol;
    }
    this.emitEvent({ type: "closed", position: pos, closeReason: reason });
  }

  emitEvent(event: PositionEvent): void {
    this.positionEventSubject.next(event);
  }

  // ── Pending Buy Dedup ─────────────────────────────────────────────

  private readonly pendingBuySet = new Set<string>();
  private readonly pendingBuyTimers = new Map<string, ReturnType<typeof setTimeout>>();

  hasPendingBuy(token: string): boolean {
    return this.pendingBuySet.has(token);
  }

  addPendingBuy(token: string): void {
    if (this.pendingBuySet.has(token)) {
      const old = this.pendingBuyTimers.get(token);
      if (old) clearTimeout(old);
      return;
    }
    this.pendingBuySet.add(token);
    const timer = setTimeout(() => {
      this.pendingBuySet.delete(token);
      this.pendingBuyTimers.delete(token);
    }, this.config.pendingBuyTtlMs);
    this.pendingBuyTimers.set(token, timer);
  }

  removePendingBuy(token: string): void {
    this.pendingBuySet.delete(token);
    const timer = this.pendingBuyTimers.get(token);
    if (timer) {
      clearTimeout(timer);
      this.pendingBuyTimers.delete(token);
    }
  }

  // ── Pair+Timestamp Duplicate Lock ─────────────────────────────────

  private readonly pairLockSet = new Set<string>();
  private readonly pairLockTimers = new Map<string, ReturnType<typeof setTimeout>>();

  isPairLocked(pair: string): boolean {
    return this.pairLockSet.has(pair);
  }

  lockPair(pair: string): void {
    const windowMs = this.config.duplicateLockWindowMs;
    const bucket = Math.floor(Date.now() / windowMs);
    const key = `${pair}:${bucket}`;
    this.pairLockSet.add(key);
    const timer = setTimeout(() => {
      this.pairLockSet.delete(key);
      this.pairLockTimers.delete(key);
    }, windowMs + 100);
    this.pairLockTimers.set(key, timer);
  }

  unlockPair(pair: string): void {
    const windowMs = this.config.duplicateLockWindowMs;
    const bucket = Math.floor(Date.now() / windowMs);
    const key = `${pair}:${bucket}`;
    this.pairLockSet.delete(key);
    const timer = this.pairLockTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.pairLockTimers.delete(key);
    }
  }

  // ── Price Cache ──────────────────────────────────────────────────

  private readonly priceCache = new Map<string, { priceUsd: number; timestamp: number }>();

  updatePriceCache(pair: string, priceUsd: number): void {
    this.priceCache.set(pair, { priceUsd, timestamp: Date.now() });
  }

  getCachedPrice(pair: string): { priceUsd: number; timestamp: number } | undefined {
    return this.priceCache.get(pair);
  }

  // ── Exposure Tracking ────────────────────────────────────────────

  protected _totalSolDeployed = 0;

  totalSolDeployed(): number {
    return this._totalSolDeployed;
  }

  addExposure(sol: number): void {
    this._totalSolDeployed += sol;
  }

  releaseExposure(sol: number): void {
    this._totalSolDeployed = Math.max(0, this._totalSolDeployed - sol);
  }

  // ── Rate Limiting ────────────────────────────────────────────────

  private readonly buyTimestamps: number[] = [];

  protected countBuysInWindow(windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    let count = 0;
    for (const ts of this.buyTimestamps) {
      if (ts >= cutoff) count++;
    }
    return count;
  }

  isBuyRateLimited(): boolean {
    if (this.countBuysInWindow(60_000) >= this.config.maxBuysPerMinute) return true;
    if (this.countBuysInWindow(3_600_000) >= this.config.maxBuysPerHour) return true;
    return false;
  }

  recordBuyTimestamp(): void {
    this.buyTimestamps.push(Date.now());
    const cutoff = Date.now() - 3_600_000;
    while (this.buyTimestamps.length > 0 && this.buyTimestamps[0]! < cutoff) {
      this.buyTimestamps.shift();
    }
  }

  // ── Cooldown ─────────────────────────────────────────────────────

  protected consecutiveLosses = 0;
  protected cooldownUntil = 0;

  protected get cooldownDurationMs(): number {
    return this.config.cooldownDurationMs ?? 1_200_000;
  }

  protected get cooldownThreshold(): number {
    return this.config.cooldownThreshold ?? 3;
  }

  checkCooldown(): boolean {
    const remaining = this.cooldownUntil - Date.now();
    if (remaining > 0) return true;
    return false;
  }

  remainingCooldownMs(): number {
    return Math.max(0, this.cooldownUntil - Date.now());
  }

  recordLoss(profitPercent: number): void {
    if (profitPercent < 0) {
      this.consecutiveLosses++;
      if (this.consecutiveLosses >= this.cooldownThreshold) {
        this.cooldownUntil = Date.now() + this.cooldownDurationMs;
      }
    } else {
      this.consecutiveLosses = 0;
    }
  }

  // ── API Failure Tracking ─────────────────────────────────────────

  protected consecutiveApiFailures = 0;

  getConsecutiveApiFailures(): number {
    return this.consecutiveApiFailures;
  }

  resetApiFailures(): void {
    this.consecutiveApiFailures = 0;
  }

  incrementApiFailures(): number {
    this.consecutiveApiFailures++;
    return this.consecutiveApiFailures;
  }

  isMaxApiFailuresReached(): boolean {
    return this.consecutiveApiFailures >= this.config.maxConsecutiveApiFailures;
  }

  // ── Daily Loss Tracking ──────────────────────────────────────────

  protected dailyLossUsd = 0;

  isDailyLossExceeded(): boolean {
    if (this.config.dailyLossLimitUsd <= 0) return false;
    return this.dailyLossUsd >= this.config.dailyLossLimitUsd;
  }

  recordDailyLoss(pnlUsd: number): void {
    if (pnlUsd >= 0) return;
    this.dailyLossUsd += Math.abs(pnlUsd);
  }

  setDailyLoss(value: number): void {
    this.dailyLossUsd = value;
  }

  getDailyLoss(): number {
    return this.dailyLossUsd;
  }
}
