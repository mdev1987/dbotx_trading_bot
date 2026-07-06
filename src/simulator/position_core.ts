// Shared core for the position lifecycle manager.
// Contains all shared infrastructure: position store, event bus, API functions,
// TP/SL polling, trade pair polling, entry price capture, trailing stop,
// position lifecycle helpers, and startup recovery.
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

// ──────────────────────────────────────────────
// Take-profit / Stop-loss helpers
// ──────────────────────────────────────────────

/**
 * Build take-profit tier groups and backstop TP from config.
 *
 * @param signalMaxPumpX - Optional max pump multiplier from the signal to scale backstop.
 * @returns Array of profit/loss groups, or undefined if no tiers configured.
 */
function buildStopEarnGroup(
  signalMaxPumpX?: number,
): ProfitLossGroup[] | undefined {
  const { partialTpEnabled, partialTpTiers, backstopTpPct } = CONFIG;

  // If partial TP is disabled, let the single backstop TP (if configured)
  // handle the full position exit, or return undefined so only the bot's own
  // exit mechanisms (trailing stop, TTL expiry, pump message) close it.
  if (!partialTpEnabled) {
    if (backstopTpPct > 0) {
      return [{ pricePercent: backstopTpPct, amountPercent: 1 }];
    }
    return undefined;
  }

  const groups: ProfitLossGroup[] = [];

  // Build TP tiers from configured partial take-profit levels
  for (const tier of partialTpTiers) {
    groups.push({ pricePercent: tier.at, amountPercent: tier.pct });
  }

  // Calculate backstop TP: use signal max pump if available, else config default
  const effectiveBackstopTpPct =
    signalMaxPumpX && signalMaxPumpX > 0
      ? (signalMaxPumpX - 1) * 0.7
      : backstopTpPct;

  // Append backstop tier with remaining allocation if any left
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
 * Build stop-loss percentage from config.
 *
 * @returns Positive stop-loss percentage, or undefined if not configured.
 */
function buildStopLossPercent(): number | undefined {
  const pct = Math.abs(CONFIG.stopLossPct);
  return pct > 0 ? pct : undefined;
}

// ──────────────────────────────────────────────
// Pending-buy dedup guard
// ──────────────────────────────────────────────

const _pendingBuys = new Set<string>();

/**
 * Mark a pair as having a pending buy in progress (dedup guard).
 *
 * @param pair - The liquidity pair address.
 */
function markPendingBuy(pair: string): void {
  _pendingBuys.add(pair);
  setTimeout(() => _pendingBuys.delete(pair), CONFIG.pendingBuyTtlMs);
}

/**
 * Check if a pair already has a pending buy.
 *
 * @param pair - The liquidity pair address.
 * @returns True if a buy is pending for this pair.
 */
function isPendingBuy(pair: string): boolean {
  return _pendingBuys.has(pair);
}

// ──────────────────────────────────────────────
// Signal queue (FIFO) with TTL, dedup, and expiration
// ──────────────────────────────────────────────

interface QueuedEntry {
  signal: ParsedSignal;
  queuedAt: number;
}

const _signalQueue = new Map<string, QueuedEntry>();

/**
 * Evict expired queue entries (those older than queue TTL).
 * Returns number of evicted items.
 */
function evictExpiredQueueEntries(): number {
  const now = Date.now();
  const maxAge = CONFIG.signalQueueTtlSecs * 1000;
  let evicted = 0;
  for (const [lp, entry] of _signalQueue) {
    if (now - entry.queuedAt >= maxAge) {
      _signalQueue.delete(lp);
      evicted++;
    }
  }
  return evicted;
}

/**
 * Enqueue a signal for deferred processing (FIFO queue).
 *
 * Deduplicates by LP address (newer signal replaces older).
 * Evicts expired entries before checking capacity.
 * When full, removes the oldest non-expired entry.
 *
 * @param signal - The parsed signal to enqueue.
 */
export function enqueueSignal(signal: ParsedSignal): void {
  // Remove expired entries first
  const expired = evictExpiredQueueEntries();
  if (expired > 0) {
    console.log(
      `[Queue] Evicted ${expired} expired signal(s) from queue`,
    );
  }

  _signalQueue.set(signal.lpAddress, { signal, queuedAt: Date.now() });

  // Evict oldest signal if queue exceeds max size
  if (_signalQueue.size > CONFIG.signalQueueSize) {
    const oldest = _signalQueue.keys().next().value;
    if (oldest) {
      _signalQueue.delete(oldest);
      console.log(
        `[Queue] Full — dropped oldest signal ${oldest}`,
      );
    }
  }

  console.log(
    `[Queue] Queued ${signal.tokenName} ` +
      `(queue size: ${_signalQueue.size})`,
  );
}

/**
 * Dequeue the next valid signal from the FIFO queue.
 *
 * Skips and removes expired entries, returning the first non-expired one.
 *
 * @returns The oldest valid signal, or undefined if the queue is empty
 *          or all remaining entries have expired.
 */
function dequeueSignal(): ParsedSignal | undefined {
  // Skip expired entries — evict them and look for the next valid one
  const now = Date.now();
  const maxAge = CONFIG.signalQueueTtlSecs * 1000;

  for (const lp of _signalQueue.keys()) {
    const entry = _signalQueue.get(lp)!;
    _signalQueue.delete(lp);

    if (now - entry.queuedAt >= maxAge) {
      console.log(
        `[Queue] Skipped expired ${entry.signal.tokenName} ` +
          `(queued ${((now - entry.queuedAt) / 1000).toFixed(0)}s ago)`,
      );
      continue;
    }

    return entry.signal;
  }

  return undefined;
}

// ──────────────────────────────────────────────
// API utilities
// ──────────────────────────────────────────────

const { baseUrl, servapiBaseUrl, dbotxApiKey } = CONFIG;
const API_HEADERS = { "x-api-key": dbotxApiKey };

interface SimApiResponse<T> {
  err: boolean;
  res: T;
  docs?: string;
}

/**
 * Build a URL string from a path and optional query parameters.
 *
 * @param path - The URL path.
 * @param params - Optional query parameters (skips undefined/null/empty values).
 * @returns The fully constructed URL string.
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
 * Generic GET request against a simulator API endpoint.
 *
 * @param base - Base URL of the API.
 * @param path - API endpoint path.
 * @param params - Optional query parameters.
 * @returns Parsed response data of type T.
 * @throws If the API returns an error flag.
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
 * Fetch PnL tasks (TP/SL orders) for a given source order from the API.
 *
 * @param sourceId - The swap order ID to fetch tasks for.
 * @returns Array of PnL task records.
 */
export async function fetchPnLTasks(sourceId: string): Promise<PnLTask[]> {
  return simGet<PnLTask[]>(
    servapiBaseUrl,
    "/simulator/pnl_orders_from_swap_order",
    { sourceId, page: 0, size: 20, sort: "-1" },
  );
}

/**
 * Fetch trade pairs from the simulator API.
 *
 * @param balanceGt0 - Filter to pairs with balance greater than 0.
 * @returns Array of trade pair records.
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
 * Fetch a buy trade record for a given order.
 *
 * @param orderId - The order ID to look up.
 * @returns The matching trade record, or null if not found or on error.
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

// ──────────────────────────────────────────────
// Position Store
// ──────────────────────────────────────────────

interface PositionCommand {
  type: "upsert" | "patch" | "remove";
  /** Position ID (used as the store key) */
  id: number;
  /** Full position object (required for upsert) */
  position?: PositionState;
  /** Partial fields to merge (required for patch) */
  patch?: Partial<PositionState>;
}

const positionCommand$ = new Subject<PositionCommand>();

export let _latestPositions = new Map<number, PositionState>();

export const positions$: Observable<Map<number, PositionState>> =
  positionCommand$.pipe(
    scan((map, cmd) => {
      // Remove: delete position from the store entirely
      if (cmd.type === "remove") {
        const next = new Map(map);
        next.delete(cmd.id);
        _latestPositions = next;
        return next;
      }
      // Upsert: replace the entire position entry for this id
      if (cmd.type === "upsert" && cmd.position) {
        const next = new Map(map);
        next.set(cmd.id, cmd.position);
        _latestPositions = next;
        return next;
      }
      // Patch: merge a partial update into the existing position fields
      if (cmd.type === "patch" && cmd.patch) {
        const existing = map.get(cmd.id);
        if (existing) {
          const next = new Map(map);
          next.set(cmd.id, {
            ...existing,
            ...cmd.patch,
            lastUpdateAt: Date.now(),
          });
          _latestPositions = next;
          return next;
        }
      }
      // Fallback: return current map unchanged
      _latestPositions = map;
      return map;
    }, new Map<number, PositionState>()),
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

/** Auto-incrementing position ID counter */
let _nextPositionId = 1;

// ──────────────────────────────────────────────
// Consecutive Loss Cooldown
// ──────────────────────────────────────────────

/** Number of consecutive losing trades */
let _consecutiveLosses = 0;

/** Timestamp (ms) until which new positions are blocked by cooldown */
let _cooldownUntil = 0;

/** How long to pause after 3+ consecutive losses (ms) */
const COOLDOWN_DURATION_MS = 20 * 60 * 1000; // 20 minutes

/** Consecutive losses needed to trigger the cooldown */
const COOLDOWN_THRESHOLD = 3;

/**
 * Replace the entire position for a given id in the store.
 *
 * @param position - The full position state to store.
 */
function upsertPosition(position: PositionState): void {
  positionCommand$.next({ type: "upsert", id: position.id, position });
}

/**
 * Apply a partial update to an existing position, identified by its ID.
 *
 * @param id - The unique position ID.
 * @param patch - Partial position fields to merge into the current state.
 */
export function patchPositionById(
  id: number,
  patch: Partial<PositionState>,
): void {
  positionCommand$.next({ type: "patch", id, patch });
}

/**
 * Apply a partial update to the oldest open position with a given LP address.
 *
 * This is a convenience wrapper for callers that only know the pair (LP address)
 * and don't have the position ID. It patches only the **oldest** open position
 * matching the pair.
 *
 * @param pair - The liquidity pair address.
 * @param patch - Partial position fields to merge.
 */
export function patchPosition(
  pair: string,
  patch: Partial<PositionState>,
): void {
  // Find the oldest open position with this pair
  let oldest: PositionState | undefined;
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

// ──────────────────────────────────────────────
// Position Event Bus
// ──────────────────────────────────────────────

const positionEventInput$ = new Subject<PositionEvent>();

export const positionEvent$: Observable<PositionEvent> =
  positionEventInput$.pipe(share());

export const positionClosed$: Observable<PositionEvent> = positionEvent$.pipe(
  filter((ev) => ev.type === "closed"),
);

/**
 * Emit a position lifecycle event to all subscribers.
 *
 * Logs the event (except for task_update noise) and pushes it onto the event bus.
 *
 * @param event - The position event to emit.
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

// ──────────────────────────────────────────────
// TP/SL Task Polling
// ──────────────────────────────────────────────

const _lastDoneCount = new Map<string, number>();

const pnlTaskPoll$ = timer(CONFIG.pnlTaskPollMs, CONFIG.pnlTaskPollMs).pipe(
  tap(() => logger.debug("[PnL] Poll tick")),
  withLatestFrom(openPositions$),
  filter(([, open]) => open.length > 0),
  concatMap(async ([, open]) => {
    // Iterate each open position and check its TP/SL task status
    for (const pos of open) {
      if (!pos.orderId) {
        logger.debug(`[PnL] ${pos.tokenName}: no orderId — skip`);
        continue;
      }
      try {
        // Fetch latest TP/SL task list from the API for this order
        const tasks = await fetchPnLTasks(pos.orderId);
        if (tasks.length === 0) {
          logger.debug(`[PnL] ${pos.tokenName}: no tasks found for order ${pos.orderId.slice(0, 12)}…`);
          continue;
        }

        logger.debug(
          `[PnL] ${pos.tokenName}: ${tasks.length} task(s): ` +
            `[${tasks.map((t) => `${t.sourceGroupIdx}=${t.state}(${t.triggerDirection})`).join(", ")}]`,
        );

        // Build a task snapshot map keyed by source group index
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
          if (
            t.state === "done" ||
            t.state === "fail" ||
            t.state === "expired"
          ) {
            anyTerminal = true;
          }
        }

        // Persist task data and best-known entry price to the position
        patchPositionById(pos.id, {
          tasks: taskMap,
          entryPriceUsd: pos.entryPriceUsd ?? tasks[0]?.basePriceUsd ?? null,
        });

        // Detect changes in completed task count to emit updates
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

        // When any task has reached a terminal state, close the position.
        // This handles two scenarios:
        //   1. Stop-loss fired → SL task is "done", other tasks may still be
        //      "init" (API leaves them untouched).  We close immediately.
        //   2. All tasks completed → close with weighted profit calculation.
        //   3. Partial TP done, remaining tasks still "init" → keep waiting,
        //      the trade pair poll or trailing stop will manage the remainder.
        //
        // We skip closing when only "up" tasks are done and some remain "init"
        // (partial TP has more room to run).
        const hasStopLoss = tasks.some(
          (t) => t.state === "done" && t.triggerDirection === "down",
        );
        const hasTakeProfit = tasks.some(
          (t) => t.state === "done" && t.triggerDirection === "up",
        );

        logger.debug(
          `[PnL] ${pos.tokenName}: anyTerminal=${anyTerminal} anyInit=${anyInit} ` +
            `hasStopLoss=${hasStopLoss} hasTakeProfit=${hasTakeProfit}`,
        );

        if (anyTerminal && tasks.length > 0) {
          // Close immediately if a stop-loss fired (all tokens sold).
          if (hasStopLoss) {
            console.log(`[PnL] Stop-loss fired for ${pos.tokenName}`);
            closePositionById(pos.id, "stop_loss");
            continue;
          }

          // Close when ALL tasks reached a terminal state (full TP execution
          // or all tasks expired/failed).
          if (!anyInit) {
            // Calculate weighted profit percentage across completed tasks
            let weightedProfitPct = 0;
            for (const t of tasks) {
              if (t.state === "done") {
                weightedProfitPct +=
                  t.triggerPercent * (t.currencyAmountUI / 100);
              }
            }
            // Derive USD profit from entry cost (or estimate from price * size)
            const cost =
              pos.entryCostUsd ??
              (pos.entryPriceUsd ? pos.entryPriceUsd * pos.sizeSol : 0);
            const profitUsd = cost * (weightedProfitPct / 100);
            patchPositionById(pos.id, {
              currentProfitPercent: weightedProfitPct,
              currentProfitUsd: profitUsd,
            });

            const reason: CloseReason = hasTakeProfit
              ? "take_profit"
              : "expired";
            console.log(
              `[PnL] All tasks terminal for ${pos.tokenName}: ` +
                `weightedPct=${weightedProfitPct.toFixed(2)}% reason=${reason}`,
            );
            closePositionById(pos.id, reason);
          } else {
            logger.debug(
              `[PnL] ${pos.tokenName}: partial TP done, some tasks still init — waiting`,
            );
          }
        }
      } catch (err) {
        console.error(
          `[position_core] PnL poll failed for ${pos.tokenName}:`,
          err,
        );
      }
    }
  }),
);

pnlTaskPoll$.subscribe();

// ──────────────────────────────────────────────
// Trade Pair Polling
// ──────────────────────────────────────────────

const tradePairPoll$ = timer(CONFIG.tradePairPollMs, CONFIG.tradePairPollMs).pipe(
  tap(() => logger.debug("[PairPoll] Tick")),
  withLatestFrom(openPositions$),
  filter(([, open]) => open.length > 0),
  concatMap(async ([, open]) => {
    try {
      // Fetch all trade pairs with positive balance from the API
      const pairs = await fetchTradePairs(true);

      logger.debug(`[PairPoll] ${pairs.length} pair(s) from API, ${open.length} open position(s)`);

      for (const pair of pairs) {
        const token = pair.tokenInfo0.contract;
        // Match each API pair to a tracked open position
        const matching = open.find((p) => p.token === token);
        if (!matching) {
          logger.debug(`[PairPoll] No match for token ${token.slice(0, 8)}…`);
          continue;
        }

        const pnlPct = (pair.fullProfitPercent * 100).toFixed(2);
        const balance = pair.token0Balance;
        const sellPct = pair.sellProfitPercent !== null
          ? (pair.sellProfitPercent * 100).toFixed(2)
          : "null";

        logger.debug(
          `[PairPoll] ${matching.tokenName}: balance=${balance} profit=${pnlPct}% ` +
            `sellProfit=${sellPct}% cost=${pair.costUsd} sellReceive=${pair.sellReceiveUsd}`,
        );

        // Sync position store with latest balance and profit data from API
        // NOTE: fullProfitPercent from the API is a fraction (e.g. -0.361 = -36.1%),
        // so multiply by 100 to match the internal percentage convention.
        patchPositionById(matching.id, {
          remainingBalance: pair.token0Balance,
          currentProfitPercent: pair.fullProfitPercent * 100,
          currentProfitUsd: pair.fullProfitUsd,
        });

        // Close position if remaining token balance has dropped to zero
        // (API task already executed the sell).  Use the API's sell-profit
        // sign to distinguish take_profit from stop_loss.
        const balanceNum = Number(pair.token0Balance);
        if (balanceNum <= 0 && matching.status === "open") {
          const reason: CloseReason =
            pair.sellProfitPercent !== null && pair.sellProfitPercent < 0
              ? "stop_loss"
              : "take_profit";
          console.log(
            `[PairPoll] Balance zero for ${matching.tokenName}: closing as ${reason}`,
          );
          closePositionById(matching.id, reason);
        } else if (
          matching.status === "open" &&
          CONFIG.stopLossPct < 0 &&
          pair.fullProfitPercent < CONFIG.stopLossPct
        ) {
          // Client-side stop-loss guard: close when PnL drops below the
          // configured threshold even if the API's SL task hasn't fired.
          // This catches cases where the simulator API doesn't execute
          // tasks (common in test environments).
          console.log(
            `[PairPoll] Client SL triggered for ${matching.tokenName}: ` +
              `${pnlPct}% <= ${(CONFIG.stopLossPct * 100).toFixed(2)}%`,
          );
          closePositionById(matching.id, "stop_loss");
        } else {
          logger.debug(
            `[PairPoll] ${matching.tokenName}: open, balance=${balanceNum} pnl=${pnlPct}% — no action`,
          );
        }
      }
    } catch (err) {
      console.error("[position_core] Trade pair poll failed:", err);
    }
  }),
);

tradePairPoll$.subscribe();

// ──────────────────────────────────────────────
// Entry Price Capture
// ──────────────────────────────────────────────

/**
 * Poll the API until an entry price is available for a given order.
 *
 * @param orderId - The buy order ID to fetch the trade record for.
 * @param positionId - The unique position ID to patch with entry data.
 * @returns The entry price in USD, or null if all attempts are exhausted.
 */
async function captureEntryPrice(
  orderId: string,
  positionId: number,
): Promise<number | null> {
  // Retry loop: attempt to fetch the trade record up to the configured max
  for (let attempt = 0; attempt < CONFIG.maxEntryPriceAttempts; attempt++) {
    try {
      const trade = await fetchBuyTrade(orderId);

      // If a trade record with a valid price is found, persist and return
      if (trade && trade.priceUsd > 0) {
        patchPositionById(positionId, {
          entryPriceUsd: trade.priceUsd,
          peakPriceUsd: trade.priceUsd,
          entryCostUsd: trade.totalUsd,
        });

        console.log(
          `[position_core] Entry price for order ${orderId}: $${trade.priceUsd}`,
        );
        return trade.priceUsd;
      }
    } catch {
      // Silently retry on transient errors
    }

    // Wait before the next poll attempt
    await new Promise((r) => setTimeout(r, CONFIG.entryPricePollDelayMs));
  }

  console.warn(
    `[position_core] Could not fetch entry price for order ${orderId}`,
  );
  return null;
}

// ──────────────────────────────────────────────
// Execution defaults (built from CONFIG)
// ──────────────────────────────────────────────

const EXEC_DEFAULTS = {
  chain: "solana" as const,
  walletId: "",
  priorityFee: "" as const,
  slippage: CONFIG.defaultSlippage,
};

// ──────────────────────────────────────────────
// Position Lifecycle Helpers
// ──────────────────────────────────────────────

/**
 * Fetch the final PnL and exit price from the trade-pairs API after a sell.
 *
 * Used by closePositionById to capture the true PnL after a market sell
 * (pump_message, trailing_stop, expired).  Retries with back-off because
 * the API may take a moment to reflect the executed trade.
 *
 * @param tokenAddress - The token contract address to look up.
 * @param retries - Number of poll attempts (default 5).
 * @param delayMs - Delay between attempts in ms (default 800).
 * @returns Final PnL data or null if all retries are exhausted.
 */
interface FinalPnLData {
  profitPct: number;
  profitUsd: number;
  exitPriceUsd: number | null;
  remainingBalance: string;
}

const FULL_PROFIT_SENTINEL = -0.9999;

async function fetchFinalPnLData(
  tokenAddress: string,
  retries = 10,
  delayMs = 1000,
): Promise<FinalPnLData | null> {
  for (let i = 0; i < retries; i++) {
    try {
      const pairs = await fetchTradePairs(false);
      const pair = pairs.find(
        (p) => p.tokenInfo0.contract === tokenAddress,
      );
      if (pair) {
        const sellAmount = Number(pair.sellTokenAmount);
        const rawProfitPct = pair.fullProfitPercent * 100;
        const hasSellData = sellAmount > 0 && pair.sellReceiveUsd > 0;

        // Detect sentinel fullProfitPercent (≤ -99.99%) — the API returns
        // this when the sell hasn't been reflected yet.  If we have sell
        // data, recompute the true PnL from sell proceeds vs total cost.
        if (rawProfitPct <= FULL_PROFIT_SENTINEL * 100 && hasSellData && pair.costUsd > 0) {
          const actualProfitPct = ((pair.sellReceiveUsd - pair.costUsd) / pair.costUsd) * 100;
          const actualProfitUsd = pair.sellReceiveUsd - pair.costUsd;
          const exitPrice = pair.sellReceiveUsd / sellAmount;
          return {
            profitPct: actualProfitPct,
            profitUsd: actualProfitUsd,
            exitPriceUsd: exitPrice,
            remainingBalance: pair.token0Balance,
          };
        }

        // Normal path: use API data directly
        const exitPrice = hasSellData ? pair.sellReceiveUsd / sellAmount : null;
        return {
          profitPct: rawProfitPct,
          profitUsd: pair.fullProfitUsd,
          exitPriceUsd: exitPrice,
          remainingBalance: pair.token0Balance,
        };
      }
    } catch {
      // transient error — retry
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}

/**
 * Close a position by its unique ID.
 *
 * Marks the position as closing, optionally executes a market sell, emits
 * a close event, and processes the next queued signal.
 *
 * @param id - The unique position ID.
 * @param reason - The reason for closing.
 */
export async function closePositionById(
  id: number,
  reason: CloseReason,
  detailOverride?: string,
): Promise<void> {
  const pos = _latestPositions.get(id);
  // Skip if position does not exist, is already closed, or is already being closed
  if (!pos || pos.status === "closed" || pos.status === "closing") {
    logger.debug(`[Close] Skip #${id}: already ${pos?.status ?? "gone"}`);
    return;
  }

  logger.debug(
    `[Close] Closing #${id} ${pos.tokenName}: reason=${reason} entry=${
      pos.entryPriceUsd ?? "?"
    } profit=${pos.currentProfitPercent.toFixed(2)}%`,
  );

  try {
    // Mark position as closing before executing any sell
    patchPositionById(id, { status: "closing", closeReason: reason });

    // Execute market sell and then fetch the final PnL from the API so the
    // close event reflects the true result (including TP profits realised
    // before the final sell).  For take_profit we first check whether the
    // API tasks already sold everything; if not, we sell the orphaned tokens.
    try {
      if (reason === "trailing_stop" || reason === "expired" || reason === "pump_message") {
        logger.debug(`[Close] ${pos.tokenName}: executing ${reason} sell (100%)`);
        const orderId = await simFastSell({
          pair: pos.pair,
          amountOrPercent: 1,
          ...EXEC_DEFAULTS,
        });

        console.log(
          `[position_core] ${reason} sell for ${pos.tokenName}: ${orderId}`,
        );

        refreshAccount$.next();
      } else if (reason === "take_profit") {
        // Check if the API tasks left any unsold tokens (e.g. when TP tiers
        // sum to less than 100 % of the position).
        const preData = await fetchFinalPnLData(pos.token);
        const balanceNum = preData ? Number(preData.remainingBalance) : 0;
        logger.debug(
          `[Close] ${pos.tokenName}: take_profit, remaining balance=${balanceNum}`,
        );
        if (balanceNum > 0) {
          const orderId = await simFastSell({
            pair: pos.pair,
            amountOrPercent: 1,
            ...EXEC_DEFAULTS,
          });

          console.log(
            `[position_core] take_profit sell (remaining ${balanceNum}) for ${pos.tokenName}: ${orderId}`,
          );

          refreshAccount$.next();
        }
      }

      // Poll the API for the updated trade-pair data so we capture the
      // correct final PnL (including previously realised TP profits).
      const finalData = await fetchFinalPnLData(pos.token);
      if (finalData) {
        logger.debug(
          `[Close] ${pos.tokenName}: final PnL — profit=${finalData.profitPct.toFixed(2)}% ` +
            `exit=${finalData.exitPriceUsd ?? "null"}`,
        );

        patchPositionById(id, {
          currentProfitPercent: finalData.profitPct,
          currentProfitUsd: finalData.profitUsd,
          exitPriceUsd: finalData.exitPriceUsd,
        });

        // Warn if the exit price is still invalid after our sentinel-recomputation
        // logic — this means the API sell data is genuinely missing.
        if (
          finalData.exitPriceUsd === null ||
          finalData.exitPriceUsd <= 0 ||
          finalData.profitPct <= FULL_PROFIT_SENTINEL * 100
        ) {
          console.warn(
            `[position_core] Final PnL data still invalid for ${pos.tokenName}: ` +
              `profitPct=${finalData.profitPct.toFixed(2)}% ` +
              `exitPriceUsd=${finalData.exitPriceUsd ?? "null"} ` +
              `— API may not have processed the sell yet`,
          );
        }
      } else {
        logger.warn(`[Close] ${pos.tokenName}: no final PnL data from API`);
      }
    } catch (err) {
      console.error(`[position_core] Failed to sell ${pos.tokenName}:`, err);
    }

    // Build final closed state from latest store data (or fallback to initial pos)
    const latest = _latestPositions.get(id) ?? pos;

    const final: PositionState = {
      ...latest,
      status: "closed",
      closeReason: reason,
      lastUpdateAt: Date.now(),
    };

    // Persist final closed state to the position store
    upsertPosition(final);

    const detail = detailOverride ?? `Closed via ${reason}`;

    // Emit close event so downstream consumers can react
    emitEvent({
      type: "closed",
      position: final,
      closeReason: reason,
      detail,
    });

    refreshAccount$.next();

    // Track consecutive losses for cooldown
    if (final.currentProfitPercent < 0) {
      _consecutiveLosses++;
      if (_consecutiveLosses >= COOLDOWN_THRESHOLD) {
        _cooldownUntil = Date.now() + COOLDOWN_DURATION_MS;
        console.log(
          `[position_core] ${_consecutiveLosses} consecutive losses — ` +
            `cooling down for ${COOLDOWN_DURATION_MS / 1000}s`,
        );
      }
    } else {
      _consecutiveLosses = 0;
    }

    // Attempt to open the next queued signal after a position closes
    processQueuedSignal();
  } catch (err) {
    console.error(`[position_core] Failed to close position #${id}:`, err);
  }
}

/**
 * Handle a pump message by selling 50 % of the position and letting the
 * trailing stop manage the remainder.
 *
 * Unlike closePositionById this does NOT close the position — the position
 * stays open so the trailing monitor can capture further upside on the
 * remaining 50 %.
 */
export async function handlePumpPartialExit(
  id: number,
  pump: AveSignalMonitorPump,
): Promise<void> {
  const pos = _latestPositions.get(id);
  if (!pos || pos.status !== "open") return;

  try {
    const orderId = await simFastSell({
      pair: pos.pair,
      amountOrPercent: 0.5,
      ...EXEC_DEFAULTS,
    });

    console.log(
      `[position_core] Pump partial sell (50 %) for ${pos.tokenName}: ${orderId}`,
    );

    refreshAccount$.next();

    emitEvent({
      type: "trailing_triggered",
      position: {
        ...pos,
        status: "open",
        lastUpdateAt: Date.now(),
      },
      detail: `Pump x${pump.multiplier} to $${pump.jumpedToK}K (from $${pump.jumpedFromK}K) — sold 50 %, trailing manages rest`,
    });
  } catch (err) {
    console.error(
      `[position_core] Failed to partial-sell ${pos.tokenName}:`,
      err,
    );
  }
}

/**
 * Close the **oldest** open position matching a given LP address.
 *
 * This is a convenience wrapper for callers that only know the pair and want
 * to close one position. If multiple positions exist for the same pair (e.g.
 * after a re-entry), the oldest one is closed.
 *
 * @param pair - The liquidity pair address.
 * @param reason - The reason for closing.
 */
export async function closePosition(pair: string, reason: CloseReason): Promise<void> {
  // Find the oldest open position with this pair
  let oldestId: number | undefined;
  let oldestTime = Infinity;
  for (const [pid, pos] of _latestPositions) {
    if (pos.pair === pair && (pos.status === "open" || pos.status === "closing")) {
      if (pos.openedAt < oldestTime) {
        oldestTime = pos.openedAt;
        oldestId = pid;
      }
    }
  }
  if (oldestId !== undefined) {
    await closePositionById(oldestId, reason);
  }
}

// ──────────────────────────────────────────────
// Signal handling
// ──────────────────────────────────────────────

/**
 * Score a signal based on wallet count, buy volume, and max pump multiplier.
 *
 * @returns A score between 0 and 1, where 1 is the highest quality.
 */
function scoreSignal(signal: ParsedSignal): number {
  const s = signal as {
    walletBuyCount?: number;
    totalBuySol?: number;
    maxPumpX?: number;
  };
  const walletScore = Math.min(1, (s.walletBuyCount ?? 0) / 5);
  const volumeScore = Math.min(1, (s.totalBuySol ?? 0) / 5);
  const pumpScore = Math.min(1, (s.maxPumpX ?? 0) / 10);
  return walletScore * 0.4 + volumeScore * 0.3 + pumpScore * 0.3;
}

/**
 * Compute the position size in SOL based on signal quality, config, and risk limits.
 *
 * When a signal is provided the position size is scaled linearly between
 * minPositionSol and maxPositionSol according to the signal's composite score
 * (wallet count, buy volume, max pump).  The result is then capped by the
 * configured risk percentage of the account balance and clamped to bounds.
 *
 * @param signal - Optional parsed signal used to compute a quality score.
 * @returns The final position size in SOL.
 */
function computePositionSize(signal?: ParsedSignal): number {
  const { minPositionSol, maxPositionSol, maxRiskPct } = CONFIG;
  let size = maxPositionSol;

  // Scale size by signal quality when signal data is available
  if (signal) {
    const score = scoreSignal(signal);
    size = minPositionSol + (maxPositionSol - minPositionSol) * score;
  }

  // Cap size by risk percentage of current account balance
  if (maxRiskPct > 0 && latestAccount?.balance) {
    const riskCap = (latestAccount.balance * maxRiskPct) / 100;
    size = Math.min(size, riskCap);
  }

  // Clamp to configured min/max position size bounds
  size = Math.max(size, minPositionSol);
  size = Math.min(size, maxPositionSol);

  return size;
}

/**
 * Open a new position by executing a buy order and persisting the position state.
 *
 * Guards against duplicate buys (unless `force` is true), respects daily loss
 * limits, computes position size, executes the buy via simFastBuy, then stores
 * and emits the result.
 *
 * When `force` is true, the pair-exists and pending-buy guards are bypassed so
 * the caller (e.g. the monitor strategy) can re-enter a pair after closing the
 * old position.
 *
 * @param signal - The parsed trading signal containing pair and token info.
 * @param options - Optional overrides (e.g. `{ force: true }` to skip guards).
 */
export async function openPosition(
  signal: ParsedSignal,
  options?: { force?: boolean },
): Promise<void> {
  // Guard: skip if a position for this pair already exists or buy is pending
  if (!options?.force) {
    let exists = false;
    for (const pos of _latestPositions.values()) {
      if (
        pos.pair === signal.lpAddress &&
        (pos.status === "open" || pos.status === "closing")
      ) {
        exists = true;
        break;
      }
    }
    if (exists || isPendingBuy(signal.lpAddress)) {
      return;
    }
  }

  // Guard: respect daily loss limit by skipping new positions when exceeded
  if (CONFIG.dailyLossLimitUsd) {
    const todayPnl = getDailyPnlUsd();
    if (todayPnl <= -CONFIG.dailyLossLimitUsd) {
      console.log(
        `[position_core] Daily loss limit reached ` +
          `(${todayPnl.toFixed(2)}) — skipping ${signal.tokenName}`,
      );
      return;
    }
  }

  // Guard: consecutive loss cooldown — pause after 3 losses in a row
  const remaining = _cooldownUntil - Date.now();
  if (remaining > 0) {
    console.log(
      `[position_core] Cooldown active (${Math.ceil(remaining / 1000)}s remaining) ` +
        `— skipping ${signal.tokenName}`,
    );
    return;
  }

  try {
    // Compute position size (scaled by signal quality) and build TP/SL parameters
    const sizeSol = computePositionSize(signal);
    const maxPumpX = (signal as { maxPumpX?: number }).maxPumpX;
    const stopEarnGroup = buildStopEarnGroup(maxPumpX);
    const stopLossPercent = buildStopLossPercent();
    const score = scoreSignal(signal);

    // Register pending buy to prevent duplicate buys for the same pair
    markPendingBuy(signal.lpAddress);

    const sigInfo = signal as { walletBuyCount?: number; totalBuySol?: number };
    console.log(
      `[position_core] Opening ${signal.tokenName}: ` +
        `score=${score.toFixed(3)} size=${sizeSol.toFixed(4)} SOL ` +
        `wallets=${sigInfo.walletBuyCount ?? "?"} ` +
        `vol=${sigInfo.totalBuySol?.toFixed(2) ?? "?"} SOL ` +
        (maxPumpX ? `maxPump=x${maxPumpX} ` : "") +
        `SL=${(stopLossPercent ?? 0) * 100}% ` +
        `TP groups=${stopEarnGroup?.length ?? 0}`,
    );

    let orderId: string;

    // Execute buy order via the simulator fast-buy API
    try {
      orderId = await simFastBuy({
        pair: signal.lpAddress,
        amountOrPercent: sizeSol,
        stopEarnGroup,
        stopLossPercent,
        ...EXEC_DEFAULTS,
      });
    } catch (err) {
      console.error(
        `[position_core] Failed to buy ${signal.tokenName}:`,
        err,
      );
      return;
    }

    const now = Date.now();

    // Construct the initial position state with null entry prices
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
    };

    // Persist position to store
    upsertPosition(position);

    // Fetch latest account balance BEFORE emitting the opened event so that
    // downstream subscribers (Telegram reporter, console logger) see the
    // balance *after* the buy fee was deducted.
    try {
      const fresh = await fetchSimulatorAccount();
      setLatestAccount(fresh);
    } catch {
      // Fall through — the reactive stream refresh below will update eventually
    }
    refreshAccount$.next();

    // Emit opened event *after* the account refresh so consumers get the
    // correct post-buy balance in the message.
    emitEvent({
      type: "opened",
      position,
      detail: `${signal.tokenName} @ ${sizeSol.toFixed(4)} SOL`,
    });

    // Start background entry-price capture (does not block open)
    captureEntryPrice(orderId, position.id);
  } catch (err) {
    console.error(
      `[position_core] Failed to open position for ${signal.tokenName}:`,
      err,
    );
  }
}

/**
 * Dequeue and process the next pending signal by opening a position.
 *
 * Called after a position closes to consume the next queued signal.
 */
async function processQueuedSignal(): Promise<void> {
  const signal = dequeueSignal();
  if (!signal) return;

  console.log(
    `[position_core] Dequeued ${signal.tokenName} — opening position`,
  );
  await openPosition(signal);
}

// ──────────────────────────────────────────────
// Startup state recovery
// ──────────────────────────────────────────────

/**
 * Recover open positions from the API on startup (state recovery).
 *
 * Fetches all active trade pairs with a positive balance from the simulator
 * API and reconstructs PositionState objects so the system can resume
 * tracking them without missing a beat.
 */
async function recoverOpenPositions(): Promise<void> {
  try {
    // Fetch all trade pairs with positive balance (i.e. currently open positions)
    const pairs = await fetchTradePairs(true);
    const now = Date.now();

    for (const p of pairs) {
      // Derive entry price from total cost / buy amount
      const entryPriceUsd =
        p.costUsd > 0 && Number(p.buyTokenAmount) > 0
          ? p.costUsd / Number(p.buyTokenAmount)
          : null;

      // Reconstruct a full PositionState from the API trade-pair data
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
        // fullProfitPercent from the API is a fraction (e.g. -0.361 = -36.1%),
        // so multiply by 100 to match the internal percentage convention.
        currentProfitPercent: (p.fullProfitPercent ?? 0) * 100,
        currentProfitUsd: p.fullProfitUsd ?? 0,
        remainingBalance: String(Number(p.buyTokenAmount) || 0),
        openedAt: now,
        expiresAt: now + CONFIG.baseTtlSecs * 1000,
        lastUpdateAt: now,
        status: "open",
        closeReason: null,
        exitPriceUsd: null,
        // Build a synthetic AveScannerSignal so the recovered position
        // satisfies the PositionState.signal type expected everywhere else
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
      };

      // Insert the recovered position into the store
      upsertPosition(pos);
      console.log(
        `[position_core] Recovered open position: ${pos.tokenName} (${p._id})`,
      );
    }
  } catch (err) {
    console.error("[position_core] Recovery failed:", err);
  }
}

recoverOpenPositions();
