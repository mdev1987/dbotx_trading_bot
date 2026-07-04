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
  withLatestFrom,
} from "rxjs/operators";
import { CONFIG } from "../config";
import type { ParsedSignal } from "../telegram/telegram_listener";
import type { AveScannerSignal } from "../telegram/ave_scanner_parser";
import { simFastBuy, simFastSell } from "./fast_buy_sell";
import type { ProfitLossGroup } from "./fast_buy_sell";
import { refreshAccount$, latestAccount } from "./account";
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
  const { partialTpTiers, backstopTpPct } = CONFIG;
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
// Signal queue (FIFO)
// ──────────────────────────────────────────────

const _signalQueue = new Map<string, ParsedSignal>();

/**
 * Enqueue a signal for deferred processing (FIFO queue).
 *
 * @param signal - The parsed signal to enqueue.
 */
export function enqueueSignal(signal: ParsedSignal): void {
  _signalQueue.set(signal.lpAddress, signal);

  // Evict oldest signal if queue exceeds max size
  if (_signalQueue.size > CONFIG.signalQueueSize) {
    const oldest = _signalQueue.keys().next().value;
    if (oldest) {
      _signalQueue.delete(oldest);
      console.log(
        `[position_core] Queue full — dropped oldest signal ${oldest}`,
      );
    }
  }

  console.log(
    `[position_core] Queued ${signal.tokenName} ` +
      `(queue size: ${_signalQueue.size})`,
  );
}

/**
 * Dequeue the oldest signal from the FIFO queue.
 *
 * @returns The oldest signal, or undefined if the queue is empty.
 */
function dequeueSignal(): ParsedSignal | undefined {
  const first = _signalQueue.keys().next().value;
  if (!first) return undefined;
  const signal = _signalQueue.get(first);
  _signalQueue.delete(first);
  return signal;
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
  pair: string;
  position?: PositionState;
  patch?: Partial<PositionState>;
}

const positionCommand$ = new Subject<PositionCommand>();

export let _latestPositions = new Map<string, PositionState>();

export const positions$: Observable<Map<string, PositionState>> =
  positionCommand$.pipe(
    scan((map, cmd) => {
      // Remove: delete position from the store entirely
      if (cmd.type === "remove") {
        const next = new Map(map);
        next.delete(cmd.pair);
        _latestPositions = next;
        return next;
      }
      // Upsert: replace the entire position entry for this pair
      if (cmd.type === "upsert" && cmd.position) {
        const next = new Map(map);
        next.set(cmd.pair, cmd.position);
        _latestPositions = next;
        return next;
      }
      // Patch: merge a partial update into the existing position fields
      if (cmd.type === "patch" && cmd.patch) {
        const existing = map.get(cmd.pair);
        if (existing) {
          const next = new Map(map);
          next.set(cmd.pair, {
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

/**
 * Replace the entire position for a given pair in the store.
 *
 * @param position - The full position state to store.
 */
function upsertPosition(position: PositionState): void {
  positionCommand$.next({ type: "upsert", pair: position.pair, position });
}

/**
 * Apply a partial update to an existing position in the store.
 *
 * @param pair - The liquidity pair address.
 * @param patch - Partial position fields to merge into the current state.
 */
export function patchPosition(
  pair: string,
  patch: Partial<PositionState>,
): void {
  positionCommand$.next({ type: "patch", pair, patch });
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
  withLatestFrom(openPositions$),
  filter(([, open]) => open.length > 0),
  concatMap(async ([, open]) => {
    // Iterate each open position and check its TP/SL task status
    for (const pos of open) {
      if (!pos.orderId) continue;
      try {
        // Fetch latest TP/SL task list from the API for this order
        const tasks = await fetchPnLTasks(pos.orderId);
        if (tasks.length === 0) continue;

        // Build a task snapshot map keyed by source group index
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

          // Track if any task is still initializing
          if (t.state === "init") allDone = false;
        }

        // Persist task data and best-known entry price to the position
        patchPosition(pos.pair, {
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

        // When all tasks are finished, compute weighted profit and close
        if (allDone && tasks.length > 0) {
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
          patchPosition(pos.pair, {
            currentProfitPercent: weightedProfitPct,
            currentProfitUsd: profitUsd,
          });

          // Determine close reason: take_profit if any task succeeded, else expired
          const reason: CloseReason = tasks.some((t) => t.state === "done")
            ? "take_profit"
            : "expired";
          closePosition(pos.pair, reason);
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
  withLatestFrom(openPositions$),
  filter(([, open]) => open.length > 0),
  concatMap(async ([, open]) => {
    try {
      // Fetch all trade pairs with positive balance from the API
      const pairs = await fetchTradePairs(true);

      for (const pair of pairs) {
        const token = pair.tokenInfo0.contract;
        // Match each API pair to a tracked open position
        const matching = open.find((p) => p.token === token);
        if (!matching) continue;

        // Sync position store with latest balance and profit data from API
        patchPosition(matching.pair, {
          remainingBalance: pair.token0Balance,
          currentProfitPercent: pair.fullProfitPercent,
          currentProfitUsd: pair.fullProfitUsd,
        });

        // Close position if remaining token balance has dropped to zero
        const balanceNum = Number(pair.token0Balance);
        if (balanceNum <= 0 && matching.status === "open") {
          closePosition(matching.pair, "take_profit");
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
 * @param pair - The liquidity pair address to patch with entry data.
 * @returns The entry price in USD, or null if all attempts are exhausted.
 */
async function captureEntryPrice(
  orderId: string,
  pair: string,
): Promise<number | null> {
  // Retry loop: attempt to fetch the trade record up to the configured max
  for (let attempt = 0; attempt < CONFIG.maxEntryPriceAttempts; attempt++) {
    try {
      const trade = await fetchBuyTrade(orderId);

      // If a trade record with a valid price is found, persist and return
      if (trade && trade.priceUsd > 0) {
        patchPosition(pair, {
          entryPriceUsd: trade.priceUsd,
          peakPriceUsd: trade.priceUsd,
          entryCostUsd: trade.totalUsd,
        });

        console.log(
          `[position_core] Entry price for ${pair}: $${trade.priceUsd}`,
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
 * Close a position by marking it as closed, optionally executing a sell,
 * emitting a close event, and processing the next queued signal.
 *
 * @param pair - The liquidity pair address to close.
 * @param reason - The reason for closing (take_profit, trailing_stop, expired, etc.).
 */
export async function closePosition(pair: string, reason: CloseReason): Promise<void> {
  const pos = _latestPositions.get(pair);
  // Skip if position does not exist, is already closed, or is already being closed
  if (!pos || pos.status === "closed" || pos.status === "closing") return;

  try {
    // Mark position as closing before executing any sell
    patchPosition(pair, { status: "closing", closeReason: reason });

    // Execute market sell for trailing stop or expired positions
    try {
      if (reason === "trailing_stop" || reason === "expired") {
        const orderId = await simFastSell({
          pair: pos.pair,
          amountOrPercent: 1,
          ...EXEC_DEFAULTS,
        });

        console.log(
          `[position_core] ${reason} sell for ${pos.tokenName}: ${orderId}`,
        );

        refreshAccount$.next();
      }
    } catch (err) {
      console.error(`[position_core] Failed to sell ${pos.tokenName}:`, err);
    }

    // Build final closed state from latest store data (or fallback to initial pos)
    const latest = _latestPositions.get(pair) ?? pos;

    const final: PositionState = {
      ...latest,
      status: "closed",
      closeReason: reason,
      lastUpdateAt: Date.now(),
    };

    // Persist final closed state to the position store
    upsertPosition(final);

    // Emit close event so downstream consumers can react
    emitEvent({
      type: "closed",
      position: final,
      closeReason: reason,
      detail: `Closed via ${reason}`,
    });

    refreshAccount$.next();

    // Attempt to open the next queued signal after a position closes
    processQueuedSignal();
  } catch (err) {
    console.error(`[position_core] Failed to close position ${pair}:`, err);
  }
}

// ──────────────────────────────────────────────
// Signal handling
// ──────────────────────────────────────────────

/**
 * Compute the position size in SOL based on config defaults and risk limits.
 *
 * Starts from the configured base size, applies risk cap, then clamps
 * to the configured min/max bounds.
 *
 * @returns The final position size in SOL.
 */
function computePositionSize(): number {
  const { positionSize, minPositionSol, maxPositionSol, maxRiskPct } = CONFIG;
  let size = positionSize;

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
 * Guards against duplicate buys, respects daily loss limits, computes position
 * size, executes the buy via simFastBuy, then stores and emits the result.
 *
 * @param signal - The parsed trading signal containing pair and token info.
 */
export async function openPosition(signal: ParsedSignal): Promise<void> {
  // Guard: skip if a position for this pair already exists or buy is pending
  if (
    _latestPositions.has(signal.lpAddress) ||
    isPendingBuy(signal.lpAddress)
  ) {
    return;
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

  try {
    // Compute position size and build TP/SL parameters from config and signal
    const sizeSol = computePositionSize();
    const maxPumpX = (signal as { maxPumpX?: number }).maxPumpX;
    const stopEarnGroup = buildStopEarnGroup(maxPumpX);
    const stopLossPercent = buildStopLossPercent();

    // Register pending buy to prevent duplicate buys for the same pair
    markPendingBuy(signal.lpAddress);

    console.log(
      `[position_core] Opening position for ${signal.tokenName} ` +
        `(${signal.lpAddress}) with ${sizeSol.toFixed(4)} SOL`,
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
    const position: PositionState = {
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
      signal,
    };

    // Persist position to store and emit opened event for downstream consumers
    upsertPosition(position);

    emitEvent({
      type: "opened",
      position,
      detail: `${signal.tokenName} @ ${sizeSol.toFixed(4)} SOL`,
    });

    // Start background entry-price capture (does not block open)
    captureEntryPrice(orderId, signal.lpAddress);
    refreshAccount$.next();
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
        expiresAt: now + CONFIG.baseTtlSecs * 1000,
        lastUpdateAt: now,
        status: "open",
        closeReason: null,
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
