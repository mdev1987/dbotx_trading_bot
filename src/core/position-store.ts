import { Subject, Observable, BehaviorSubject } from "rxjs";
import { filter, map, share } from "rxjs/operators";
import type { PositionState, PositionEvent, CloseReason } from "./types";

/** Configuration options for the PositionStore */
export interface PositionStoreConfig {
  baseTtlSecs: number; // Base time-to-live for positions in seconds
  pendingBuyTtlMs: number; // How long a pending buy lock lives in milliseconds
  duplicateLockWindowMs: number; // Time window for duplicate pair locking
  maxBuysPerMinute: number; // Maximum buys allowed in a 60-second window
  maxBuysPerHour: number; // Maximum buys allowed in a 60-minute window
  maxConsecutiveApiFailures: number; // Threshold before stopping on API errors
  dailyLossLimitUsd: number; // Maximum cumulative daily loss in USD
  maxTotalSolDeployed: number; // Max SOL that can be deployed at once
  cooldownDurationMs?: number; // Duration of cooldown after consecutive losses
  cooldownThreshold?: number; // Number of consecutive losses to trigger cooldown
}

/** In-memory store for all position state, with event emission and safety guards */
export class PositionStore {
  protected readonly store = new Map<number, PositionState>(); // Internal position map keyed by ID
  protected nextPositionId = 1; // Monotonic ID counter for new positions

  // ── Event Subjects & Observables ──────────────────────────────────

  protected readonly positionEventSubject = new Subject<PositionEvent>(); // Raw event stream
  /** Observable of all position events, shared across subscribers */
  readonly positionEvent$: Observable<PositionEvent> = this.positionEventSubject.pipe(share());

  /** Emits the position snapshot each time a position is opened */
  readonly positionOpened$: Observable<PositionState> = this.positionEvent$.pipe(
    filter((e): e is PositionEvent & { type: "opened" } => e.type === "opened"), // Filter to opened events
    map((e) => e.position), // Extract the position payload
  );

  /** Emits the position snapshot each time a position is closed */
  readonly positionClosed$: Observable<PositionState> = this.positionEvent$.pipe(
    filter((e): e is PositionEvent & { type: "closed" } => e.type === "closed"), // Filter to closed events
    map((e) => e.position), // Extract the position payload
  );

  /** Emits the current array of non-closed positions on every event */
  readonly openPositions$: Observable<PositionState[]> = this.positionEvent$.pipe(
    map(() => {
      const open: PositionState[] = [];
      for (const pos of this.store.values()) {
        if (pos.status === "open" || pos.status === "closing") open.push(pos);
      }
      return open; // Return filtered list of live positions
    }),
  );

  protected _latestPositions: ReadonlyMap<number, PositionState> = this.store; // Snapshot pointer

  constructor(protected readonly config: PositionStoreConfig) {} // Store configuration reference

  /** Snapshot of all positions at the last write */
  get latestPositions(): ReadonlyMap<number, PositionState> {
    return this._latestPositions;
  }

  /** Generate a new monotonically increasing position ID */
  generateId(): number {
    return this.nextPositionId++;
  }

  /** Ensure the ID counter stays ahead of a restored value (e.g. from persistence) */
  syncIdCounter(id: number): void {
    if (id >= this.nextPositionId) {
      this.nextPositionId = id + 1; // Bump past the restored ID
    }
  }

  /** Look up a position by its numeric ID */
  get(id: number): PositionState | undefined {
    return this.store.get(id);
  }

  /** Find a position by its exchange order ID */
  getByOrderId(orderId: string): PositionState | undefined {
    for (const pos of this.store.values()) {
      if (pos.orderId === orderId) return pos; // Match found
    }
    return undefined; // No match
  }

  /** Find an active (non-closed) position by token address */
  getByToken(token: string): PositionState | undefined {
    for (const pos of this.store.values()) {
      if (pos.token === token && pos.status !== "closed") return pos; // Match on token + active
    }
    return undefined;
  }

  /** Find an active (non-closed) position by trading pair */
  getByPair(pair: string): PositionState | undefined {
    for (const pos of this.store.values()) {
      if (pos.pair === pair && pos.status !== "closed") return pos; // Match on pair + active
    }
    return undefined;
  }

  /** Count all positions that are still open or in the process of closing */
  countOpen(): number {
    let count = 0;
    for (const pos of this.store.values()) {
      if (pos.status === "open" || pos.status === "closing") count++;
    }
    return count;
  }

  /** Upsert a full position object into the store */
  set(position: PositionState): void {
    this.store.set(position.id, position); // Insert or overwrite by ID
    this._latestPositions = this.store; // Refresh the snapshot reference
  }

  /** Partially update fields on an existing position and emit an "updated" event */
  patch(id: number, patch: Partial<PositionState>): PositionState | undefined {
    const pos = this.store.get(id);
    if (!pos) return undefined; // Position not found
    Object.assign(pos, patch, { lastUpdateAt: Date.now() }); // Merge patch + bump timestamp
    this.emitEvent({ type: "updated", position: pos });
    return pos;
  }

  /** Transition a position from "open" to "closing" status */
  markClosing(id: number): void {
    const pos = this.store.get(id);
    if (!pos || pos.status !== "open") return; // Only closeable if currently open
    pos.status = "closing";
    pos.lastUpdateAt = Date.now();
    this.emitEvent({ type: "closing", position: pos });
  }

  /** Mark a position as fully closed with a reason and optional exit price */
  markClosed(id: number, reason: CloseReason, exitPriceUsd?: number): void {
    const pos = this.store.get(id);
    if (!pos || pos.status === "closed") return; // Already closed
    pos.status = "closed";
    pos.closeReason = reason;
    pos.exitPriceUsd = exitPriceUsd ?? pos.exitPriceUsd; // Keep existing exit price if none provided
    pos.lastUpdateAt = Date.now();
    if (pos.entryPriceUsd && exitPriceUsd) {
      // Calculate final PnL based on actual exit price
      pos.currentProfitPercent = (exitPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd;
      pos.currentProfitUsd = pos.currentProfitPercent * pos.sizeSol;
    }
    this.emitEvent({ type: "closed", position: pos, closeReason: reason });
  }

  /** Push a raw PositionEvent onto the subject stream */
  emitEvent(event: PositionEvent): void {
    this.positionEventSubject.next(event);
  }

  // ── Pending Buy Dedup ─────────────────────────────────────────────

  private readonly pendingBuySet = new Set<string>(); // Tokens with an in-flight buy
  private readonly pendingBuyTimers = new Map<string, ReturnType<typeof setTimeout>>(); // Auto-expiry timers

  /** Check whether a buy is already pending for this token */
  hasPendingBuy(token: string): boolean {
    return this.pendingBuySet.has(token);
  }

  /** Register a pending buy and schedule its automatic removal */
  addPendingBuy(token: string): void {
    if (this.pendingBuySet.has(token)) {
      const old = this.pendingBuyTimers.get(token);
      if (old) clearTimeout(old); // Reset the expiry timer
      return;
    }
    this.pendingBuySet.add(token);
    const timer = setTimeout(() => {
      this.pendingBuySet.delete(token); // Auto-remove after TTL
      this.pendingBuyTimers.delete(token); // Clean up timer reference
    }, this.config.pendingBuyTtlMs);
    this.pendingBuyTimers.set(token, timer);
  }

  /** Remove a pending buy lock (e.g. because the buy completed or failed) */
  removePendingBuy(token: string): void {
    this.pendingBuySet.delete(token);
    const timer = this.pendingBuyTimers.get(token);
    if (timer) {
      clearTimeout(timer); // Cancel the expiry timer
      this.pendingBuyTimers.delete(token);
    }
  }

  // ── Pair+Timestamp Duplicate Lock ─────────────────────────────────

  private readonly pairLockSet = new Set<string>(); // Locked pair+bucket keys
  private readonly pairLockTimers = new Map<string, ReturnType<typeof setTimeout>>(); // Auto-unlock timers

  /** Check whether a pair is locked in the current time bucket */
  isPairLocked(pair: string): boolean {
    return this.pairLockSet.has(pair);
  }

  /** Lock a pair for the duration of the duplicate lock window */
  lockPair(pair: string): void {
    const windowMs = this.config.duplicateLockWindowMs;
    const bucket = Math.floor(Date.now() / windowMs); // Time bucket index
    const key = `${pair}:${bucket}`; // Composite key of pair + bucket
    this.pairLockSet.add(key);
    const timer = setTimeout(() => {
      this.pairLockSet.delete(key); // Auto-unlock after window
      this.pairLockTimers.delete(key);
    }, windowMs + 100); // Small buffer to ensure bucket boundary
    this.pairLockTimers.set(key, timer);
  }

  /** Manually unlock a pair in the current time bucket */
  unlockPair(pair: string): void {
    const windowMs = this.config.duplicateLockWindowMs;
    const bucket = Math.floor(Date.now() / windowMs);
    const key = `${pair}:${bucket}`;
    this.pairLockSet.delete(key);
    const timer = this.pairLockTimers.get(key);
    if (timer) {
      clearTimeout(timer); // Cancel the scheduled unlock
      this.pairLockTimers.delete(key);
    }
  }

  // ── Price Cache ──────────────────────────────────────────────────

  private readonly priceCache = new Map<string, { priceUsd: number; timestamp: number }>(); // pair -> cached price + time

  /** Store the latest price for a pair in the in-memory cache */
  updatePriceCache(pair: string, priceUsd: number): void {
    this.priceCache.set(pair, { priceUsd, timestamp: Date.now() });
  }

  /** Retrieve the cached price for a pair, if available */
  getCachedPrice(pair: string): { priceUsd: number; timestamp: number } | undefined {
    return this.priceCache.get(pair);
  }

  // ── Exposure Tracking ────────────────────────────────────────────

  protected _totalSolDeployed = 0; // Running total of SOL currently in positions

  /** Get the total SOL currently deployed across all open positions */
  totalSolDeployed(): number {
    return this._totalSolDeployed;
  }

  /** Add SOL to the deployed total (when a buy fills) */
  addExposure(sol: number): void {
    this._totalSolDeployed += sol;
  }

  /** Subtract SOL from the deployed total, clamped to zero (when a position closes) */
  releaseExposure(sol: number): void {
    this._totalSolDeployed = Math.max(0, this._totalSolDeployed - sol);
  }

  // ── Rate Limiting ────────────────────────────────────────────────

  private readonly buyTimestamps: number[] = []; // Timestamps of recent buys

  /** Count how many buys occurred within the given millisecond window */
  protected countBuysInWindow(windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    let count = 0;
    for (const ts of this.buyTimestamps) {
      if (ts >= cutoff) count++; // Within window
    }
    return count;
  }

  /** Check whether the buy rate limit has been exceeded (per-minute or per-hour) */
  isBuyRateLimited(): boolean {
    if (this.countBuysInWindow(60_000) >= this.config.maxBuysPerMinute) return true;
    if (this.countBuysInWindow(3_600_000) >= this.config.maxBuysPerHour) return true;
    return false;
  }

  /** Record a buy timestamp and prune entries older than 1 hour */
  recordBuyTimestamp(): void {
    this.buyTimestamps.push(Date.now());
    const cutoff = Date.now() - 3_600_000; // 1 hour ago
    while (this.buyTimestamps.length > 0 && this.buyTimestamps[0]! < cutoff) {
      this.buyTimestamps.shift(); // Remove expired entries from the front
    }
  }

  // ── Cooldown ─────────────────────────────────────────────────────

  protected consecutiveLosses = 0; // Count of consecutive losing trades
  protected cooldownUntil = 0; // Timestamp until which trading is paused

  /** Duration of cooldown in ms (defaults to 20 minutes) */
  protected get cooldownDurationMs(): number {
    return this.config.cooldownDurationMs ?? 1_200_000;
  }

  /** Number of consecutive losses before cooldown triggers (defaults to 3) */
  protected get cooldownThreshold(): number {
    return this.config.cooldownThreshold ?? 3;
  }

  /** Returns true if the system is currently in cooldown */
  checkCooldown(): boolean {
    const remaining = this.cooldownUntil - Date.now();
    if (remaining > 0) return true; // Still in cooldown
    return false;
  }

  /** Milliseconds remaining until cooldown ends, or 0 */
  remainingCooldownMs(): number {
    return Math.max(0, this.cooldownUntil - Date.now());
  }

  /** Track a trade result; increment consecutive losses or reset on win */
  recordLoss(profitPercent: number): void {
    if (profitPercent < 0) {
      this.consecutiveLosses++; // Loss streak continues
      if (this.consecutiveLosses >= this.cooldownThreshold) {
        this.cooldownUntil = Date.now() + this.cooldownDurationMs; // Enter cooldown
      }
    } else {
      this.consecutiveLosses = 0; // Reset streak on profitable trade
    }
  }

  // ── API Failure Tracking ─────────────────────────────────────────

  protected consecutiveApiFailures = 0; // Running count of API failures

  /** Get the current consecutive API failure count */
  getConsecutiveApiFailures(): number {
    return this.consecutiveApiFailures;
  }

  /** Reset the API failure counter (e.g. after a successful call) */
  resetApiFailures(): void {
    this.consecutiveApiFailures = 0;
  }

  /** Increment the API failure counter and return the new value */
  incrementApiFailures(): number {
    this.consecutiveApiFailures++;
    return this.consecutiveApiFailures;
  }

  /** Check whether the max consecutive API failure threshold has been hit */
  isMaxApiFailuresReached(): boolean {
    return this.consecutiveApiFailures >= this.config.maxConsecutiveApiFailures;
  }

  // ── Daily Loss Tracking ──────────────────────────────────────────

  protected dailyLossUsd = 0; // Cumulative realized loss for the current day

  /** Check whether the daily loss limit has been exceeded */
  isDailyLossExceeded(): boolean {
    if (this.config.dailyLossLimitUsd <= 0) return false; // No limit configured
    return this.dailyLossUsd >= this.config.dailyLossLimitUsd;
  }

  /** Accumulate a loss (negative PnL) into the daily loss total */
  recordDailyLoss(pnlUsd: number): void {
    if (pnlUsd >= 0) return; // Only losses count
    this.dailyLossUsd += Math.abs(pnlUsd); // Add absolute value
  }

  /** Overwrite the daily loss counter (e.g. when restoring from persistence) */
  setDailyLoss(value: number): void {
    this.dailyLossUsd = value;
  }

  /** Read the current daily loss total */
  getDailyLoss(): number {
    return this.dailyLossUsd;
  }
}
