import { Subject, timer, Observable } from "rxjs";
import {
  filter,
  map,
  scan,
  share,
  shareReplay,
  concatMap,
  tap,
  withLatestFrom,
} from "rxjs/operators";
import { CONFIG } from "../config";
import { logger } from "../utils/logger";
import type { ParsedSignal } from "../telegram/telegram_listener";
import type { AveScannerSignal } from "../telegram/ave_scanner_parser";
import { simFastBuy, simFastSell } from "./fast_buy_sell";
import type { ProfitLossGroup } from "./fast_buy_sell";
import { refreshAccount$, latestAccount, fetchSimulatorAccount, setLatestAccount } from "./account";
import { fetchWithRetry } from "./http";
import { getDailyPnlUsd } from "../analytics/reports";
import type { AveSignalMonitorPump } from "../telegram/ave_signal_monitor_parser";
import type {
  CloseReason,
  PnLTask,
  PnLTaskSnapshot,
  PositionEvent,
  PositionState,
  TradePair,
  TradeRecord,
} from "./types";
import { PositionStore } from "../core/position-store";
import { SignalQueue } from "../core/signal-queue";

/** Configuration for the in-memory position store. */
const storeConfig = {
  baseTtlSecs: CONFIG.baseTtlSecs,
  pendingBuyTtlMs: CONFIG.pendingBuyTtlMs,
  duplicateLockWindowMs: CONFIG.duplicateLockWindowMs,
  maxBuysPerMinute: CONFIG.maxBuysPerMinute,
  maxBuysPerHour: CONFIG.maxBuysPerHour,
  maxConsecutiveApiFailures: 0,
  dailyLossLimitUsd: CONFIG.dailyLossLimitUsd,
  maxTotalSolDeployed: 0,
  cooldownDurationMs: 20 * 60 * 1000,
  cooldownThreshold: 3,
};

const store = new PositionStore(storeConfig);
const signalQueue = new SignalQueue(
  CONFIG.signalQueueSize,
  CONFIG.signalQueueTtlSecs,
);

// ── TP/SL Helpers ───────────────────────────────────────────────────────────

/**
 * Build a tiered take-profit group from config, optionally capping the
 * backstop tier at 70 % of the signal's maxPumpX.
 * @param signalMaxPumpX - Optional multiplier from the signal (e.g. 5x).
 * @returns An array of profit/loss groups, or undefined if TP is disabled.
 */
function buildStopEarnGroup(
  signalMaxPumpX?: number,
): ProfitLossGroup[] | undefined {
  const { partialTpEnabled, partialTpTiers, backstopTpPct } = CONFIG;

  if (!partialTpEnabled) {
    if (backstopTpPct > 0) {
      return [{ pricePercent: backstopTpPct, amountPercent: 1 }];
    }
    return undefined;
  }

  const groups: ProfitLossGroup[] = [];

  for (const tier of partialTpTiers) {
    groups.push({ pricePercent: tier.at, amountPercent: tier.pct });
  }

  const effectiveBackstopTpPct =
    signalMaxPumpX && signalMaxPumpX > 0
      ? (signalMaxPumpX - 1) * 0.7
      : backstopTpPct;

  if (effectiveBackstopTpPct > 0) {
    const soldSoFar = partialTpTiers.reduce((sum, t) => sum + t.pct, 0);
    const remaining = 1 - soldSoFar;

    if (remaining > 0.001) {
      groups.push({
        pricePercent: effectiveBackstopTpPct,
        amountPercent: remaining,
      });
    }
  }

  return groups.length > 0 ? groups : undefined;
}

/**
 * Read the configured stop-loss percentage (absolute value).
 * @returns The SL percentage, or undefined if set to 0.
 */
function buildStopLossPercent(): number | undefined {
  const pct = Math.abs(CONFIG.stopLossPct);
  return pct > 0 ? pct : undefined;
}

// ── Pending Buy Dedup ───────────────────────────────────────────────────────

/** Set of token pairs currently being bought (prevents duplicate buys). */
const _pendingBuys = new Set<string>();

/**
 * Mark a pair as pending buy; auto-expires after the configured TTL.
 * @param pair - The LP/token address being bought.
 */
function markPendingBuy(pair: string): void {
  _pendingBuys.add(pair);
  setTimeout(() => _pendingBuys.delete(pair), CONFIG.pendingBuyTtlMs);
}

/**
 * Check whether a buy is already pending for the given pair.
 * @param pair - The LP/token address to check.
 * @returns `true` if a buy is already in flight.
 */
function isPendingBuy(pair: string): boolean {
  return _pendingBuys.has(pair);
}

// ── API Utilities ───────────────────────────────────────────────────────────

const { baseUrl, servapiBaseUrl, dbotxApiKey } = CONFIG;
const API_HEADERS = { "x-api-key": dbotxApiKey };

/** Generic envelope returned by the simulator API. */
interface SimApiResponse<T> {
  err: boolean;
  res: T;
  docs?: string;
}

/**
 * Build a URL from a path and optional query parameters.
 * @param path - URL path.
 * @param params - Optional query parameters (null/undefined values are skipped).
 * @returns The fully-qualified URL string.
 */
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

/**
 * Generic GET request against the simulator API.
 * @param base - Base URL (e.g. baseUrl or servapiBaseUrl).
 * @param path - API path.
 * @param params - Optional query parameters.
 * @returns The unwrapped response payload.
 */
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
    throw new Error("[position_core] API returned err: true");
  }
  return json.res;
}

/**
 * Fetch all PnL tasks for a given swap order (source ID).
 * @param sourceId - The order ID to fetch PnL tasks for.
 * @returns Array of PnL tasks sorted descending (most recent first).
 */
export async function fetchPnLTasks(sourceId: string): Promise<PnLTask[]> {
  return simGet<PnLTask[]>(
    servapiBaseUrl,
    "/simulator/pnl_orders_from_swap_order",
    { sourceId, page: 0, size: 20, sort: "-1" },
  );
}

/**
 * Fetch open / historical trade pairs from the simulator.
 * @param balanceGt0 - When `true`, only return pairs with a remaining balance > 0.
 * @returns Array of trade pairs.
 */
export async function fetchTradePairs(
  balanceGt0: boolean,
): Promise<TradePair[]> {
  return simGet<TradePair[]>(servapiBaseUrl, "/simulator/trade_pairs", {
    page: 0,
    size: 20,
    chain: "solana",
    balanceGt0: balanceGt0 ? "true" : "false",
  });
}

/**
 * Fetch a single buy trade record by order ID, or `null` if not found / on error.
 * @param orderId - The order ID to look up.
 * @returns The matching trade record, or `null`.
 */
async function fetchBuyTrade(orderId: string): Promise<TradeRecord | null> {
  try {
    const trades = await simGet<TradeRecord[]>(baseUrl, "/simulator/trades", {});
    return trades.find((t) => t.id === orderId) ?? null;
  } catch (err) {
    console.error(`[position_core] Failed to fetch buy trade ${orderId}:`, err);
    return null;
  }
}

// ── Position Store (RxJS-based, backward compatible) ────────────────────────

/** Internal command type for the position store observable. */
interface PositionCommand {
  type: "upsert" | "patch" | "remove";
  id: number;
  position?: PositionState;
  patch?: Partial<PositionState>;
}

/** Subject that feeds position mutations into the reactive store. */
const positionCommand$ = new Subject<PositionCommand>();

/**
 * Snapshot of the latest position map, kept in sync with the store for
 * synchronous reads by external consumers.
 */
export let _latestPositions = new Map<number, PositionState>();

// Sync _latestPositions from the backing PositionStore whenever it emits
store.openPositions$.subscribe(() => {
  _latestPositions = new Map(store.latestPositions as unknown as Map<number, PositionState>);
});

/**
 * Observable stream of all positions keyed by ID.
 * Supports upsert, patch, and remove operations via the command subject.
 */
export const positions$: Observable<Map<number, PositionState>> =
  positionCommand$.pipe(
    scan((map, cmd) => {
      // Remove an entry by ID
      if (cmd.type === "remove") {
        const next = new Map(map);
        next.delete(cmd.id);
        _latestPositions = next;
        return next;
      }
      // Insert or fully replace a position
      if (cmd.type === "upsert" && cmd.position) {
        const next = new Map(map);
        next.set(cmd.id, cmd.position);
        _latestPositions = next;
        return next;
      }
      // Partial update: merge patch into existing position
      if (cmd.type === "patch" && cmd.patch) {
        const existing = map.get(cmd.id);
        if (existing) {
          const next = new Map(map);
          next.set(cmd.id, { ...existing, ...cmd.patch, lastUpdateAt: Date.now() });
          _latestPositions = next;
          return next;
        }
      }
      _latestPositions = map;
      return map;
    }, new Map<number, PositionState>()),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

/**
 * Observable emitting only open / closing positions (filtered from `positions$`).
 */
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

// ── Position Event Bus ──────────────────────────────────────────────────────

/** Raw subject for pushing position lifecycle events. */
const positionEventInput$ = new Subject<PositionEvent>();

/** Shared stream of all position events. */
export const positionEvent$: Observable<PositionEvent> =
  positionEventInput$.pipe(share());

/** Stream filtered to position-closed events only. */
export const positionClosed$: Observable<PositionEvent> = positionEvent$.pipe(
  filter((ev) => ev.type === "closed"),
);

/**
 * Publish a position lifecycle event (opened, closed, task_update, etc.).
 * Non-task events are also logged to the console.
 * @param event - The event payload to emit.
 */
export function emitEvent(event: PositionEvent): void {
  if (event.type !== "task_update") {
    console.log(
      `[POSITION] ${event.position.tokenName}: ${event.type}` +
        (event.detail ? ` - ${event.detail}` : ""),
    );
  }
  positionEventInput$.next(event);
}

// ── Position Helpers ────────────────────────────────────────────────────────

/**
 * Apply a partial patch to a position by its numeric ID.
 * @param id - The position's unique ID.
 * @param patch - Partial fields to merge into the position.
 */
export function patchPositionById(
  id: number,
  patch: Partial<PositionState>,
): void {
  positionCommand$.next({ type: "patch", id, patch });
}

/**
 * Apply a partial patch to the oldest open/closing position matching a pair.
 * @param pair - The LP/token address to look up.
 * @param patch - Partial fields to merge into the position.
 */
export function patchPosition(
  pair: string,
  patch: Partial<PositionState>,
): void {
  let oldest: PositionState | undefined;
  // Find the oldest open or closing position for this pair
  for (const pos of _latestPositions.values()) {
    if (pos.pair === pair && (pos.status === "open" || pos.status === "closing")) {
      if (!oldest || pos.openedAt < oldest.openedAt) {
        oldest = pos;
      }
    }
  }
  if (oldest) {
    positionCommand$.next({ type: "patch", id: oldest.id, patch });
  }
}

/** Insert or replace a position in both the store and the reactive map. */
function upsertPosition(position: PositionState): void {
  store.set(position);
  positionCommand$.next({ type: "upsert", id: position.id, position });
}

// ── PnL Peak Tracking (Polling-Based Trailing) ──────────────────────────────

/** Tracks the peak PnL fraction per position ID for trailing-stop logic. */
const _pnlPeakMap = new Map<number, number>();
/** Sentinel value indicating a full close has occurred (approx -100 %). */
const FULL_PROFIT_SENTINEL = -0.9999;

// ── Execution Defaults ──────────────────────────────────────────────────────

/** Shared defaults used for every sim-fast-buy / sim-fast-sell call. */
const EXEC_DEFAULTS = {
  chain: "solana" as const,
  walletId: "",
  priorityFee: "" as const,
  slippage: CONFIG.defaultSlippage,
};

// ── PnL Task Polling ────────────────────────────────────────────────────────

/** Tracks the last known count of "done" tasks per order ID (for change detection). */
const _lastDoneCount = new Map<string, number>();

/**
 * Start a periodic poll that checks PnL tasks for every open position.
 * When all tasks reach a terminal state, the position is closed automatically.
 */
export function startPnLTaskPoll(): void {
  timer(CONFIG.pnlTaskPollMs, CONFIG.pnlTaskPollMs).pipe(
    tap(() => logger.debug("[PnL] Poll tick")),
    // Only proceed when there are open positions
    withLatestFrom(openPositions$),
    filter(([, open]) => open.length > 0),
    // Process positions serially to avoid concurrent API storms
    concatMap(async ([, open]) => {
      for (const pos of open) {
        if (!pos.orderId) continue;
        try {
          const tasks = await fetchPnLTasks(pos.orderId);
          if (tasks.length === 0) continue;

          // Build a snapshot map keyed by source group index
          const taskMap = new Map<number, PnLTaskSnapshot>();
          let anyTerminal = false;
          let anyInit = false;

          for (const t of tasks) {
            taskMap.set(t.sourceGroupIdx, {
              groupIdx: t.sourceGroupIdx,
              state: t.state,
              triggerPriceUsd: t.triggerPriceUsd,
              basePriceUsd: t.basePriceUsd,
              amountPercent: t.currencyAmountUI,
              pnlPercent: t.triggerPercent,
            });

            if (t.state === "init") anyInit = true;
            if (t.state === "done" || t.state === "fail" || t.state === "expired") {
              anyTerminal = true;
            }
          }

          // Persist the task snapshot and ensure entry price is set
          patchPositionById(pos.id, {
            tasks: taskMap,
            entryPriceUsd: pos.entryPriceUsd ?? tasks[0]?.basePriceUsd ?? null,
          });

          // Emit an event whenever the done count changes
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

          const hasStopLoss = tasks.some(
            (t) => t.state === "done" && t.triggerDirection === "down",
          );
          const hasTakeProfit = tasks.some(
            (t) => t.state === "done" && t.triggerDirection === "up",
          );

          // If any task reached terminal state, decide what to do
          if (anyTerminal && tasks.length > 0) {
            // Stop-loss triggered → close immediately
            if (hasStopLoss) {
              closePositionById(pos.id, "stop_loss");
              continue;
            }

            // No tasks still initializing → compute final PnL and close
            if (!anyInit) {
              let weightedProfitPct = 0;
              for (const t of tasks) {
                if (t.state === "done") {
                  weightedProfitPct += t.triggerPercent * (t.currencyAmountUI / 100);
                }
              }
              const cost = pos.entryCostUsd ?? (pos.entryPriceUsd ? pos.entryPriceUsd * pos.sizeSol : 0);
              const profitUsd = cost * (weightedProfitPct / 100);
              patchPositionById(pos.id, {
                currentProfitPercent: weightedProfitPct,
                currentProfitUsd: profitUsd,
              });

              const reason: CloseReason = hasTakeProfit ? "take_profit" : "expired";
              closePositionById(pos.id, reason);
            }
          }
        } catch (err) {
          console.error(`[position_core] PnL poll failed for ${pos.tokenName}:`, err);
        }
      }
    }),
  ).subscribe();
}

// ── Trade Pair Polling ──────────────────────────────────────────────────────

/**
 * Start a periodic poll that checks trade pair data (balance, PnL) for
 * every open position, handling auto-close via zero balance, stop-loss,
 * trailing-stop, and trailing take-profit.
 */
export function startTradePairPoll(): void {
  timer(CONFIG.tradePairPollMs, CONFIG.tradePairPollMs).pipe(
    tap(() => logger.debug("[PairPoll] Tick")),
    // Only poll when there are open positions
    withLatestFrom(openPositions$),
    filter(([, open]) => open.length > 0),
    concatMap(async ([, open]) => {
      try {
        const pairs = await fetchTradePairs(true);

        for (const pair of pairs) {
          const token = pair.tokenInfo0.contract;
          const matching = open.find((p) => p.token === token);
          if (!matching) continue;

          // Update position with latest balance and PnL from the API
          patchPositionById(matching.id, {
            remainingBalance: pair.token0Balance,
            currentProfitPercent: pair.fullProfitPercent * 100,
            currentProfitUsd: pair.fullProfitUsd,
          });

          const balanceNum = Number(pair.token0Balance);
          // Balance dropped to zero → position was fully sold on-chain
          if (balanceNum <= 0 && matching.status === "open") {
            const reason: CloseReason =
              pair.sellProfitPercent !== null && pair.sellProfitPercent < 0
                ? "stop_loss"
                : "take_profit";
            closePositionById(matching.id, reason);
          } else if (
            matching.status === "open" &&
            CONFIG.stopLossPct < 0 &&
            pair.fullProfitPercent > FULL_PROFIT_SENTINEL &&
            pair.fullProfitPercent < CONFIG.stopLossPct
          ) {
            // Hard stop-loss threshold breached
            const slReason: CloseReason =
              pair.sellProfitPercent !== null && pair.sellProfitPercent < 0
                ? "stop_loss"
                : "take_profit";
            closePositionById(matching.id, slReason);
          } else {
            // Trailing stop / trailing TP (fallback when WS unavailable)
            const pnlFraction = pair.fullProfitPercent;
            const prevPeak = _pnlPeakMap.get(matching.id) ?? pnlFraction;

            // Track new PnL peaks
            if (pnlFraction > prevPeak) {
              _pnlPeakMap.set(matching.id, pnlFraction);
            }

            // Trailing take-profit: close when PnL drops by trailingTpDistancePct from peak
            if (
              CONFIG.trailingTpDistancePct > 0 &&
              prevPeak > 0 &&
              pnlFraction < prevPeak - CONFIG.trailingTpDistancePct
            ) {
              closePositionById(matching.id, "take_profit");
            }

            // Trailing stop-loss: close when PnL drops by trailingDistancePct from peak (above activation threshold)
            if (
              CONFIG.trailingDistancePct > 0 &&
              prevPeak > CONFIG.trailingActivationPct &&
              pnlFraction < prevPeak - CONFIG.trailingDistancePct
            ) {
              closePositionById(matching.id, "trailing_stop");
            }
          }
        }
      } catch (err) {
        console.error("[position_core] Trade pair poll failed:", err);
      }
    }),
  ).subscribe();
}

// ── Entry Price Capture ─────────────────────────────────────────────────────

/** Auto-incrementing ID counter for new positions. */
let _nextPositionId = 1;

/**
 * Poll the API until the buy trade's entry price is available, then record it
 * on the position.
 * @param orderId - The order ID to fetch the trade for.
 * @param positionId - The position ID to patch.
 * @returns The captured entry price, or `null` if all attempts fail.
 */
async function captureEntryPrice(
  orderId: string,
  positionId: number,
): Promise<number | null> {
  for (let attempt = 0; attempt < CONFIG.maxEntryPriceAttempts; attempt++) {
    try {
      const trade = await fetchBuyTrade(orderId);

      if (trade && trade.priceUsd > 0) {
        patchPositionById(positionId, {
          entryPriceUsd: trade.priceUsd,
          peakPriceUsd: trade.priceUsd,
          entryCostUsd: trade.totalUsd,
        });
        return trade.priceUsd;
      }
    } catch {
      // Transient error — retry on the next loop iteration
    }

    await new Promise((r) => setTimeout(r, CONFIG.entryPricePollDelayMs));
  }

  console.warn(`[position_core] Could not fetch entry price for order ${orderId}`);
  return null;
}

// ── PnL Data Fetching ───────────────────────────────────────────────────────

/** Shape of the resolved PnL result after a position closes. */
interface FinalPnLData {
  profitPct: number;
  profitUsd: number;
  exitPriceUsd: number | null;
  remainingBalance: string;
}

/**
 * Poll the trade-pairs endpoint until a closed pair's final PnL data is available.
 * Falls back to computing actual PnL from sell revenue when the API returns the
 * sentinel value.
 * @param tokenAddress - The token contract address to look up.
 * @param retries - Maximum number of poll attempts (default 10).
 * @param delayMs - Delay between attempts in ms (default 1000).
 * @returns The final PnL data, or `null` if never found.
 */
async function fetchFinalPnLData(
  tokenAddress: string,
  retries = 10,
  delayMs = 1000,
): Promise<FinalPnLData | null> {
  for (let i = 0; i < retries; i++) {
    try {
      const pairs = await fetchTradePairs(false);
      const pair = pairs.find((p) => p.tokenInfo0.contract === tokenAddress);
      if (pair) {
        const sellAmount = Number(pair.sellTokenAmount);
        const rawProfitPct = pair.fullProfitPercent * 100;
        const hasSellData = sellAmount > 0 && pair.sellReceiveUsd > 0;

        // The API may report ~-100 % when the position is actually closed;
        // compute the real PnL from cost vs. sell-receive in that case.
        if (rawProfitPct <= FULL_PROFIT_SENTINEL * 100 && hasSellData && pair.costUsd > 0) {
          const actualProfitPct = ((pair.sellReceiveUsd - pair.costUsd) / pair.costUsd) * 100;
          const actualProfitUsd = pair.sellReceiveUsd - pair.costUsd;
          const exitPrice = pair.sellReceiveUsd / sellAmount;
          return { profitPct: actualProfitPct, profitUsd: actualProfitUsd, exitPriceUsd: exitPrice, remainingBalance: pair.token0Balance };
        }

        const exitPrice = hasSellData ? pair.sellReceiveUsd / sellAmount : null;
        return { profitPct: rawProfitPct, profitUsd: pair.fullProfitUsd, exitPriceUsd: exitPrice, remainingBalance: pair.token0Balance };
      }
    } catch {
      // Transient error — retry on next attempt
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}

// ── Signal Scoring & Sizing ─────────────────────────────────────────────────

/**
 * Compute a quality score (0-1) from a signal's wallet count, volume, and pump multiplier.
 * @param signal - The parsed signal to score.
 * @returns A score between 0 and 1.
 */
function scoreSignal(signal: ParsedSignal): number {
  const s = signal as { walletBuyCount?: number; totalBuySol?: number; maxPumpX?: number };
  const walletScore = Math.min(1, (s.walletBuyCount ?? 0) / 5);
  const volumeScore = Math.min(1, (s.totalBuySol ?? 0) / 5);
  const pumpScore = Math.min(1, (s.maxPumpX ?? 0) / 10);
  return walletScore * 0.4 + volumeScore * 0.3 + pumpScore * 0.3;
}

/**
 * Determine the SOL position size based on config ranges and risk limits.
 * @param _signal - Optional signal (currently unused; reserved for future signal-aware sizing).
 * @returns The position size in SOL.
 */
function computePositionSize(_signal?: ParsedSignal): number {
  const { minPositionSol, maxPositionSol, maxRiskPct } = CONFIG;
  let size = maxPositionSol;

  // Cap by risk % of current account balance
  if (maxRiskPct > 0 && latestAccount?.balance) {
    const riskCapUsd = (latestAccount.balance * maxRiskPct) / 100;
    size = Math.min(size, riskCapUsd);
  }

  // Clamp to configured min/max bounds
  size = Math.max(size, minPositionSol);
  size = Math.min(size, maxPositionSol);

  return size;
}

// ── Open Position ───────────────────────────────────────────────────────────

/**
 * Open a new position for the given signal by executing a simulated buy.
 * Respects duplicate guards, daily loss limits, and cooldown state.
 * @param signal - The parsed signal to act on.
 * @param options - Optional overrides (e.g. `force` to skip duplicate checks).
 */
export async function openPosition(
  signal: ParsedSignal,
  options?: { force?: boolean },
): Promise<void> {
  // Dedup check: skip if an open position already exists for this pair or a buy is pending
  if (!options?.force) {
    let exists = false;
    for (const pos of _latestPositions.values()) {
      if (pos.pair === signal.lpAddress && (pos.status === "open" || pos.status === "closing")) {
        exists = true;
        break;
      }
    }
    if (exists || isPendingBuy(signal.lpAddress)) return;
  }

  // Daily loss limit check — do not open if already breached
  if (CONFIG.dailyLossLimitUsd) {
    const todayPnl = getDailyPnlUsd();
    if (todayPnl <= -CONFIG.dailyLossLimitUsd) return;
  }

  // Cooldown check — do not open if frequently losing
  if (store.checkCooldown()) return;

  try {
    // Compute size and TP/SL config
    const sizeSol = computePositionSize(signal);
    const maxPumpX = (signal as { maxPumpX?: number }).maxPumpX;
    const stopEarnGroup = buildStopEarnGroup(maxPumpX);
    const stopLossPercent = buildStopLossPercent();

    // Record this pair as pending to prevent duplicate buys
    markPendingBuy(signal.lpAddress);

    let orderId: string;

    // Execute the simulated buy
    try {
      orderId = await simFastBuy({
        pair: signal.lpAddress,
        amountOrPercent: sizeSol,
        stopEarnGroup,
        stopLossPercent,
        ...EXEC_DEFAULTS,
      });
    } catch (err) {
      console.error(`[position_core] Failed to buy ${signal.tokenName}:`, err);
      return;
    }

    // Build the full position state object
    const now = Date.now();
    const positionId = _nextPositionId++;
    const position: PositionState = {
      id: positionId,
      orderId,
      pair: signal.lpAddress,
      token: signal.contractAddress,
      tokenName: signal.tokenName ?? "unknown",
      entryPriceUsd: null,
      entryCostUsd: null,
      sizeSol,
      peakPriceUsd: 0,
      trailingActive: false,
      tasks: new Map(),
      currentProfitPercent: 0,
      currentProfitUsd: 0,
      remainingBalance: "0",
      openedAt: now,
      expiresAt: now + CONFIG.baseTtlSecs * 1000,
      lastUpdateAt: now,
      status: "open",
      closeReason: null,
      exitPriceUsd: null,
      signal,
      filledSol: 0,
      avgFillPriceUsd: null,
      tokenSymbol: "",
    };

    // Persist in both the reactive store and the backing PositionStore
    upsertPosition(position);

    // Refresh account balance after the buy
    try {
      const fresh = await fetchSimulatorAccount();
      setLatestAccount(fresh);
    } catch {
      // Best-effort; account refresh is non-critical
    }
    refreshAccount$.next();

    // Emit the "opened" event for downstream consumers
    emitEvent({
      type: "opened",
      position,
      detail: `${signal.tokenName} @ ${sizeSol.toFixed(4)} SOL`,
    });

    // Fire-and-forget entry price capture (runs in background)
    captureEntryPrice(orderId, position.id);
  } catch (err) {
    console.error(`[position_core] Failed to open position for ${signal.tokenName}:`, err);
  }
}

// ── Close Position ──────────────────────────────────────────────────────────

/**
 * Close a position by its numeric ID with the given reason.
 * Handles sell execution, final PnL capture, event emission, and cooldown tracking.
 * @param id - The position ID to close.
 * @param reason - Why the position is being closed.
 * @param detailOverride - Optional custom detail string for the event.
 */
export async function closePositionById(
  id: number,
  reason: CloseReason,
  detailOverride?: string,
): Promise<void> {
  const pos = _latestPositions.get(id);
  // Guard: skip if already closed or closing
  if (!pos || pos.status === "closed" || pos.status === "closing") return;

  try {
    // Mark as closing immediately to prevent re-entry
    patchPositionById(id, { status: "closing", closeReason: reason });

    try {
      // For trailing/expired/pump exits, sell the full balance regardless
      if (reason === "trailing_stop" || reason === "expired" || reason === "pump_message") {
        const orderId = await simFastSell({ pair: pos.pair, amountOrPercent: 1, ...EXEC_DEFAULTS });
        refreshAccount$.next();
      } else if (reason === "take_profit" || reason === "stop_loss") {
        // TP/SL — check if there's still balance to sell (task-based TP/SL may have already sold)
        const preData = await fetchFinalPnLData(pos.token);
        const balanceNum = preData ? Number(preData.remainingBalance) : 0;
        if (balanceNum > 0) {
          await simFastSell({ pair: pos.pair, amountOrPercent: 1, ...EXEC_DEFAULTS });
          refreshAccount$.next();
        }
      }

      // Fetch final PnL data and update position
      const finalData = await fetchFinalPnLData(pos.token);
      if (finalData) {
        patchPositionById(id, {
          currentProfitPercent: finalData.profitPct,
          currentProfitUsd: finalData.profitUsd,
          exitPriceUsd: finalData.exitPriceUsd,
        });
      }
    } catch (err) {
      console.error(`[position_core] Failed to sell ${pos.tokenName}:`, err);
    }

    // Build and persist the final closed state
    const latest = _latestPositions.get(id) ?? pos;
    const final: PositionState = {
      ...latest,
      status: "closed",
      closeReason: reason,
      lastUpdateAt: Date.now(),
    };

    upsertPosition(final);

    // Emit the "closed" event
    const detail = detailOverride ?? `Closed via ${reason}`;
    emitEvent({ type: "closed", position: final, closeReason: reason, detail });

    // Refresh account and clean up peak tracking
    refreshAccount$.next();
    _pnlPeakMap.delete(id);

    // Record loss for cooldown tracking if closed at a loss
    if (final.currentProfitPercent < 0) {
      store.recordLoss(final.currentProfitPercent);
    }

    // Process the next signal from the queue (if any)
    processQueuedSignal();
  } catch (err) {
    console.error(`[position_core] Failed to close position #${id}:`, err);
  }
}

/**
 * Close the oldest open/closing position matching a given pair.
 * @param pair - The LP/token address to look up.
 * @param reason - Why the position is being closed.
 */
export async function closePosition(pair: string, reason: CloseReason): Promise<void> {
  let oldestId: number | undefined;
  let oldestTime = Infinity;
  // Find the oldest open/closing position for this pair
  for (const [pid, p] of _latestPositions) {
    if (p.pair === pair && (p.status === "open" || p.status === "closing")) {
      if (p.openedAt < oldestTime) {
        oldestTime = p.openedAt;
        oldestId = pid;
      }
    }
  }
  if (oldestId !== undefined) {
    await closePositionById(oldestId, reason);
  }
}

// ── Pump Partial Exit ───────────────────────────────────────────────────────

/**
 * Sell 50 % of a position when a pump alert fires, letting the trailing logic
 * manage the remainder.
 * @param id - The position ID to partially exit.
 * @param pump - The pump alert data (multiplier and jumped-to market cap).
 */
export async function handlePumpPartialExit(
  id: number,
  pump: AveSignalMonitorPump,
): Promise<void> {
  const pos = _latestPositions.get(id);
  // Only act on positions that are still actively open
  if (!pos || pos.status !== "open") return;

  try {
    // Sell half the position
    const orderId = await simFastSell({
      pair: pos.pair,
      amountOrPercent: 0.5,
      ...EXEC_DEFAULTS,
    });

    refreshAccount$.next();

    // Notify downstream consumers about the partial exit
    emitEvent({
      type: "trailing_triggered",
      position: { ...pos, status: "open", lastUpdateAt: Date.now() },
      detail: `Pump x${pump.multiplier} to $${pump.jumpedToK}K — sold 50 %, trailing manages rest`,
    });
  } catch (err) {
    console.error(`[position_core] Failed to partial-sell ${pos.tokenName}:`, err);
  }
}

// ── Signal Queue ────────────────────────────────────────────────────────────

/**
 * Enqueue a signal for deferred processing when a position slot opens up.
 * @param signal - The parsed signal to queue.
 */
export function enqueueSignal(signal: ParsedSignal): void {
  signalQueue.enqueue(signal);
}

/** Dequeue the next pending signal (internal). */
function dequeueSignal(): ParsedSignal | undefined {
  const s = signalQueue.dequeue();
  return s ?? undefined;
}

/** Return the current number of queued signals. */
export function queueLength(): number {
  return signalQueue.length;
}

/** Clear the signal queue (used in tests to reset state). */
export function _clearQueueForTest(): void {
  signalQueue.clear();
}

/** Try to process the next queued signal by opening a position for it. */
async function processQueuedSignal(): Promise<void> {
  const signal = dequeueSignal();
  if (!signal) return;
  await openPosition(signal);
}

// ── Recovery ────────────────────────────────────────────────────────────────

/**
 * Recover open positions from the API after a restart.
 * Fetches all trade pairs with non-zero balance and re-creates in-memory position states.
 */
export async function recoverOpenPositions(): Promise<void> {
  try {
    // Fetch all trade pairs that still have a balance
    const pairs = await fetchTradePairs(true);
    const now = Date.now();

    for (const p of pairs) {
      // Compute entry price from cost / buy amount
      const entryPriceUsd = p.costUsd > 0 && Number(p.buyTokenAmount) > 0
        ? p.costUsd / Number(p.buyTokenAmount)
        : null;

      // Build a synthetic PositionState from the API response
      const pos: PositionState = {
        id: _nextPositionId++,
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
        currentProfitPercent: (p.fullProfitPercent ?? 0) * 100,
        currentProfitUsd: p.fullProfitUsd ?? 0,
        remainingBalance: String(Number(p.buyTokenAmount) || 0),
        openedAt: now,
        expiresAt: now + CONFIG.baseTtlSecs * 1000,
        lastUpdateAt: now,
        status: "open",
        closeReason: null,
        exitPriceUsd: null,
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
        } as AveScannerSignal,
        filledSol: 0,
        avgFillPriceUsd: null,
        tokenSymbol: p.tokenInfo0.symbol ?? "",
      };

      // Persist the recovered position
      upsertPosition(pos);
    }
  } catch (err) {
    console.error("[position_core] Recovery failed:", err);
  }
}
