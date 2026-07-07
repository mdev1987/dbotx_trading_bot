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

// ── Internal Services ───────────────────────────────────────────────────────

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

function buildStopLossPercent(): number | undefined {
  const pct = Math.abs(CONFIG.stopLossPct);
  return pct > 0 ? pct : undefined;
}

// ── Pending Buy Dedup ───────────────────────────────────────────────────────

const _pendingBuys = new Set<string>();

function markPendingBuy(pair: string): void {
  _pendingBuys.add(pair);
  setTimeout(() => _pendingBuys.delete(pair), CONFIG.pendingBuyTtlMs);
}

function isPendingBuy(pair: string): boolean {
  return _pendingBuys.has(pair);
}

// ── API Utilities ───────────────────────────────────────────────────────────

const { baseUrl, servapiBaseUrl, dbotxApiKey } = CONFIG;
const API_HEADERS = { "x-api-key": dbotxApiKey };

interface SimApiResponse<T> {
  err: boolean;
  res: T;
  docs?: string;
}

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
    throw new Error("[position_core] API returned err: true");
  }
  return json.res;
}

export async function fetchPnLTasks(sourceId: string): Promise<PnLTask[]> {
  return simGet<PnLTask[]>(
    servapiBaseUrl,
    "/simulator/pnl_orders_from_swap_order",
    { sourceId, page: 0, size: 20, sort: "-1" },
  );
}

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

interface PositionCommand {
  type: "upsert" | "patch" | "remove";
  id: number;
  position?: PositionState;
  patch?: Partial<PositionState>;
}

const positionCommand$ = new Subject<PositionCommand>();

export let _latestPositions = new Map<number, PositionState>();

// Keep backward compat: _latestPositions sync
store.openPositions$.subscribe(() => {
  _latestPositions = new Map(store.latestPositions as unknown as Map<number, PositionState>);
});

export const positions$: Observable<Map<number, PositionState>> =
  positionCommand$.pipe(
    scan((map, cmd) => {
      if (cmd.type === "remove") {
        const next = new Map(map);
        next.delete(cmd.id);
        _latestPositions = next;
        return next;
      }
      if (cmd.type === "upsert" && cmd.position) {
        const next = new Map(map);
        next.set(cmd.id, cmd.position);
        _latestPositions = next;
        return next;
      }
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

const positionEventInput$ = new Subject<PositionEvent>();

export const positionEvent$: Observable<PositionEvent> =
  positionEventInput$.pipe(share());

export const positionClosed$: Observable<PositionEvent> = positionEvent$.pipe(
  filter((ev) => ev.type === "closed"),
);

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

export function patchPositionById(
  id: number,
  patch: Partial<PositionState>,
): void {
  positionCommand$.next({ type: "patch", id, patch });
}

export function patchPosition(
  pair: string,
  patch: Partial<PositionState>,
): void {
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

function upsertPosition(position: PositionState): void {
  store.set(position);
  positionCommand$.next({ type: "upsert", id: position.id, position });
}

// ── PnL Peak Tracking (Polling-Based Trailing) ──────────────────────────────

const _pnlPeakMap = new Map<number, number>();
const FULL_PROFIT_SENTINEL = -0.9999;

// ── Execution Defaults ──────────────────────────────────────────────────────

const EXEC_DEFAULTS = {
  chain: "solana" as const,
  walletId: "",
  priorityFee: "" as const,
  slippage: CONFIG.defaultSlippage,
};

// ── PnL Task Polling ────────────────────────────────────────────────────────

const _lastDoneCount = new Map<string, number>();

export function startPnLTaskPoll(): void {
  timer(CONFIG.pnlTaskPollMs, CONFIG.pnlTaskPollMs).pipe(
    tap(() => logger.debug("[PnL] Poll tick")),
    withLatestFrom(openPositions$),
    filter(([, open]) => open.length > 0),
    concatMap(async ([, open]) => {
      for (const pos of open) {
        if (!pos.orderId) continue;
        try {
          const tasks = await fetchPnLTasks(pos.orderId);
          if (tasks.length === 0) continue;

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

          patchPositionById(pos.id, {
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

          const hasStopLoss = tasks.some(
            (t) => t.state === "done" && t.triggerDirection === "down",
          );
          const hasTakeProfit = tasks.some(
            (t) => t.state === "done" && t.triggerDirection === "up",
          );

          if (anyTerminal && tasks.length > 0) {
            if (hasStopLoss) {
              closePositionById(pos.id, "stop_loss");
              continue;
            }

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

export function startTradePairPoll(): void {
  timer(CONFIG.tradePairPollMs, CONFIG.tradePairPollMs).pipe(
    tap(() => logger.debug("[PairPoll] Tick")),
    withLatestFrom(openPositions$),
    filter(([, open]) => open.length > 0),
    concatMap(async ([, open]) => {
      try {
        const pairs = await fetchTradePairs(true);

        for (const pair of pairs) {
          const token = pair.tokenInfo0.contract;
          const matching = open.find((p) => p.token === token);
          if (!matching) continue;

          patchPositionById(matching.id, {
            remainingBalance: pair.token0Balance,
            currentProfitPercent: pair.fullProfitPercent * 100,
            currentProfitUsd: pair.fullProfitUsd,
          });

          const balanceNum = Number(pair.token0Balance);
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
            const slReason: CloseReason =
              pair.sellProfitPercent !== null && pair.sellProfitPercent < 0
                ? "stop_loss"
                : "take_profit";
            closePositionById(matching.id, slReason);
          } else {
            // PnL-based trailing stop/TP (WS-independent fallback)
            const pnlFraction = pair.fullProfitPercent;
            const prevPeak = _pnlPeakMap.get(matching.id) ?? pnlFraction;

            if (pnlFraction > prevPeak) {
              _pnlPeakMap.set(matching.id, pnlFraction);
            }

            if (
              CONFIG.trailingTpDistancePct > 0 &&
              prevPeak > 0 &&
              pnlFraction < prevPeak - CONFIG.trailingTpDistancePct
            ) {
              closePositionById(matching.id, "take_profit");
            }

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

let _nextPositionId = 1;

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
      // silent retry
    }

    await new Promise((r) => setTimeout(r, CONFIG.entryPricePollDelayMs));
  }

  console.warn(`[position_core] Could not fetch entry price for order ${orderId}`);
  return null;
}

// ── PnL Data Fetching ───────────────────────────────────────────────────────

interface FinalPnLData {
  profitPct: number;
  profitUsd: number;
  exitPriceUsd: number | null;
  remainingBalance: string;
}

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
      // transient error — retry
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}

// ── Signal Scoring & Sizing ─────────────────────────────────────────────────

function scoreSignal(signal: ParsedSignal): number {
  const s = signal as { walletBuyCount?: number; totalBuySol?: number; maxPumpX?: number };
  const walletScore = Math.min(1, (s.walletBuyCount ?? 0) / 5);
  const volumeScore = Math.min(1, (s.totalBuySol ?? 0) / 5);
  const pumpScore = Math.min(1, (s.maxPumpX ?? 0) / 10);
  return walletScore * 0.4 + volumeScore * 0.3 + pumpScore * 0.3;
}

function computePositionSize(_signal?: ParsedSignal): number {
  const { minPositionSol, maxPositionSol, maxRiskPct } = CONFIG;
  let size = maxPositionSol;

  if (maxRiskPct > 0 && latestAccount?.balance) {
    const riskCapUsd = (latestAccount.balance * maxRiskPct) / 100;
    size = Math.min(size, riskCapUsd);
  }

  size = Math.max(size, minPositionSol);
  size = Math.min(size, maxPositionSol);

  return size;
}

// ── Open Position ───────────────────────────────────────────────────────────

export async function openPosition(
  signal: ParsedSignal,
  options?: { force?: boolean },
): Promise<void> {
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

  if (CONFIG.dailyLossLimitUsd) {
    const todayPnl = getDailyPnlUsd();
    if (todayPnl <= -CONFIG.dailyLossLimitUsd) return;
  }

  if (store.checkCooldown()) return;

  try {
    const sizeSol = computePositionSize(signal);
    const maxPumpX = (signal as { maxPumpX?: number }).maxPumpX;
    const stopEarnGroup = buildStopEarnGroup(maxPumpX);
    const stopLossPercent = buildStopLossPercent();

    markPendingBuy(signal.lpAddress);

    let orderId: string;

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

    upsertPosition(position);

    try {
      const fresh = await fetchSimulatorAccount();
      setLatestAccount(fresh);
    } catch {
      // fall through
    }
    refreshAccount$.next();

    emitEvent({
      type: "opened",
      position,
      detail: `${signal.tokenName} @ ${sizeSol.toFixed(4)} SOL`,
    });

    captureEntryPrice(orderId, position.id);
  } catch (err) {
    console.error(`[position_core] Failed to open position for ${signal.tokenName}:`, err);
  }
}

// ── Close Position ──────────────────────────────────────────────────────────

export async function closePositionById(
  id: number,
  reason: CloseReason,
  detailOverride?: string,
): Promise<void> {
  const pos = _latestPositions.get(id);
  if (!pos || pos.status === "closed" || pos.status === "closing") return;

  try {
    patchPositionById(id, { status: "closing", closeReason: reason });

    try {
      if (reason === "trailing_stop" || reason === "expired" || reason === "pump_message") {
        const orderId = await simFastSell({ pair: pos.pair, amountOrPercent: 1, ...EXEC_DEFAULTS });
        refreshAccount$.next();
      } else if (reason === "take_profit" || reason === "stop_loss") {
        const preData = await fetchFinalPnLData(pos.token);
        const balanceNum = preData ? Number(preData.remainingBalance) : 0;
        if (balanceNum > 0) {
          await simFastSell({ pair: pos.pair, amountOrPercent: 1, ...EXEC_DEFAULTS });
          refreshAccount$.next();
        }
      }

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

    const latest = _latestPositions.get(id) ?? pos;
    const final: PositionState = {
      ...latest,
      status: "closed",
      closeReason: reason,
      lastUpdateAt: Date.now(),
    };

    upsertPosition(final);

    const detail = detailOverride ?? `Closed via ${reason}`;
    emitEvent({ type: "closed", position: final, closeReason: reason, detail });

    refreshAccount$.next();
    _pnlPeakMap.delete(id);

    if (final.currentProfitPercent < 0) {
      store.recordLoss(final.currentProfitPercent);
    }

    processQueuedSignal();
  } catch (err) {
    console.error(`[position_core] Failed to close position #${id}:`, err);
  }
}

export async function closePosition(pair: string, reason: CloseReason): Promise<void> {
  let oldestId: number | undefined;
  let oldestTime = Infinity;
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

    refreshAccount$.next();

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

export function enqueueSignal(signal: ParsedSignal): void {
  signalQueue.enqueue(signal);
}

function dequeueSignal(): ParsedSignal | undefined {
  const s = signalQueue.dequeue();
  return s ?? undefined;
}

export function queueLength(): number {
  return signalQueue.length;
}

export function _clearQueueForTest(): void {
  signalQueue.clear();
}

async function processQueuedSignal(): Promise<void> {
  const signal = dequeueSignal();
  if (!signal) return;
  await openPosition(signal);
}

// ── Recovery ────────────────────────────────────────────────────────────────

export async function recoverOpenPositions(): Promise<void> {
  try {
    const pairs = await fetchTradePairs(true);
    const now = Date.now();

    for (const p of pairs) {
      const entryPriceUsd = p.costUsd > 0 && Number(p.buyTokenAmount) > 0
        ? p.costUsd / Number(p.buyTokenAmount)
        : null;

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

      upsertPosition(pos);
    }
  } catch (err) {
    console.error("[position_core] Recovery failed:", err);
  }
}
