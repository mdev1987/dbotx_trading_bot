import { Subject, timer, Observable, BehaviorSubject } from "rxjs";
import {
  filter,
  map,
  withLatestFrom,
  tap,
  concatMap,
  share,
  shareReplay,
  scan,
  startWith,
} from "rxjs/operators";

import { CONFIG } from "./config";
import type {
  PositionState,
  PositionEvent,
  CloseReason,
  PriceUpdate,
  ParsedSignal,
  PerformanceReport,
} from "./dbotx/types";
import {
  priceUpdate$,
  subscribePairs,
  unsubscribePair,
  pushPriceUpdate,
  simBuy,
  simSell,
  liveBuy,
  liveSell,
  pollOrderUntilDone,
  querySwapOrder,
  fetchTradePairs,
  fetchPnLTasks,
  fetchBuyTrade,
  startRestPricePolling,
  startSimPairPoll,
  startSimPnLPoll,
  tradeResultEvent$,
  buySuccessEvent$,
  sellSuccessEvent$,
  tpSuccessEvent$,
  slSuccessEvent$,
  refreshAccount$,
  latestSimAccount,
  simAccount$,
} from "./dbotx";
import {
  acceptedSignal$,
  signalPaused$,
  expiredPair$,
  wireReporter,
} from "./telegram";

// ── Position Store ─────────────────────────────────────────────────────────

let _nextId = 1;
const _positions = new Map<number, PositionState>();
const _pendingBuys = new Set<string>();
const _pnlPeakMap = new Map<number, number>();

type Command =
  | { type: "upsert"; id: number; pos: PositionState }
  | { type: "patch"; id: number; patch: Partial<PositionState> }
  | { type: "remove"; id: number };

const command$ = new Subject<Command>();

export const positions$: Observable<Map<number, PositionState>> = command$.pipe(
  scan((map, cmd) => {
    switch (cmd.type) {
      case "upsert": {
        const m = new Map(map);
        m.set(cmd.id, cmd.pos);
        return m;
      }
      case "patch": {
        const existing = map.get(cmd.id);
        if (!existing) return map;
        const m = new Map(map);
        m.set(cmd.id, { ...existing, ...cmd.patch, lastUpdateAt: Date.now() });
        return m;
      }
      case "remove": {
        const m = new Map(map);
        m.delete(cmd.id);
        return m;
      }
      default:
        return map;
    }
  }, new Map<number, PositionState>()),
  shareReplay({ bufferSize: 1, refCount: true }),
);

export const _latestPositions = new Map<number, PositionState>();
positions$.subscribe((m) => {
  _latestPositions.clear();
  for (const [k, v] of m) _latestPositions.set(k, v);
});

export const openPositions$: Observable<PositionState[]> = positions$.pipe(
  map((m) => {
    const open: PositionState[] = [];
    for (const p of m.values()) {
      if (p.status === "open" || p.status === "closing") open.push(p);
    }
    return open;
  }),
  startWith([] as PositionState[]),
  shareReplay({ bufferSize: 1, refCount: true }),
);

export const openOrderIds$: Observable<string[]> = openPositions$.pipe(
  map((ps) =>
    ps
      .filter((p) => p.orderId && !p.orderId.startsWith("paper_"))
      .map((p) => p.orderId),
  ),
);

const positionEventInput$ = new Subject<PositionEvent>();
export const positionEvent$: Observable<PositionEvent> =
  positionEventInput$.pipe(share());
export const positionClosed$: Observable<PositionEvent> = positionEvent$.pipe(
  filter((e) => e.type === "closed"),
);

function emitEvent(event: PositionEvent): void {
  console.log(
    `[BOT] ${event.position.tokenName}: ${event.type}${event.detail ? ` - ${event.detail}` : ""}`,
  );
  positionEventInput$.next(event);
}

function upsertPosition(pos: PositionState): void {
  command$.next({ type: "upsert", id: pos.id, pos });
}

function patchPosition(id: number, patch: Partial<PositionState>): void {
  command$.next({ type: "patch", id, patch });
}

// ── Entry Price Capture ────────────────────────────────────────────────────

async function captureEntryPriceSim(
  orderId: string,
  positionId: number,
): Promise<void> {
  for (let i = 0; i < CONFIG.maxEntryPriceAttempts; i++) {
    try {
      const trade = await fetchBuyTrade(orderId);
      if (trade && trade.priceUsd > 0) {
        patchPosition(positionId, {
          entryPriceUsd: trade.priceUsd,
          peakPriceUsd: trade.priceUsd,
          entryCostUsd: trade.totalUsd,
        });
        return;
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, CONFIG.entryPricePollDelayMs));
  }
  console.warn(`[BOT] Could not fetch entry price for order ${orderId}`);
}

async function captureEntryPriceLive(
  orderId: string,
  positionId: number,
): Promise<void> {
  try {
    const order = await pollOrderUntilDone(orderId);
    if (order.txPriceUsd && order.txPriceUsd > 0) {
      patchPosition(positionId, {
        entryPriceUsd: order.txPriceUsd,
        peakPriceUsd: order.txPriceUsd,
      });
    }
  } catch (err) {
    console.warn(`[BOT] Entry price capture failed for order ${orderId}:`, err);
  }
  const pos = _latestPositions.get(positionId);
  if (pos?.token) _pendingBuys.delete(pos.token);
}

// ── Open Position ──────────────────────────────────────────────────────────

export async function openPosition(signal: ParsedSignal): Promise<number> {
  // Dedup checks
  for (const pos of _latestPositions.values()) {
    if (
      pos.pair === signal.lpAddress &&
      (pos.status === "open" || pos.status === "closing")
    )
      return 0;
  }
  if (_pendingBuys.has(signal.lpAddress)) return 0;

  _pendingBuys.add(signal.lpAddress);
  setTimeout(
    () => _pendingBuys.delete(signal.lpAddress),
    CONFIG.pendingBuyTtlMs,
  );

  const sizeSol = computePositionSize(signal);
  const now = Date.now();
  const positionId = _nextId++;

  try {
    let orderId: string;
    if (CONFIG.liveMode) {
      orderId = await liveBuy(signal.lpAddress, sizeSol, signal);
    } else {
      orderId = await simBuy(signal.lpAddress, sizeSol);
    }

    const position: PositionState = {
      id: positionId,
      orderId,
      pair: signal.lpAddress,
      token: signal.contractAddress,
      tokenName: signal.tokenName ?? "unknown",
      tokenSymbol: "",
      entryPriceUsd: null,
      entryCostUsd: null,
      sizeSol,
      filledSol: CONFIG.liveMode ? 0 : sizeSol,
      avgFillPriceUsd: null,
      peakPriceUsd: 0,
      trailingActive: false,
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

    upsertPosition(position);
    subscribePairs([{ pair: signal.lpAddress, token: signal.contractAddress }]);
    emitEvent({
      type: "opened",
      position,
      detail: `${signal.tokenName} @ ${sizeSol.toFixed(4)} SOL`,
    });

    refreshAccount$.next();

    // Async entry price capture
    if (CONFIG.liveMode) captureEntryPriceLive(orderId, positionId);
    else captureEntryPriceSim(orderId, positionId);

    return positionId;
  } catch (err) {
    console.error(`[BOT] Failed to buy ${signal.tokenName}:`, err);
    return 0;
  }
}

function computePositionSize(_signal?: ParsedSignal): number {
  const { minPositionSol, maxPositionSol, maxRiskPct } = CONFIG;
  let size = maxPositionSol;
  if (maxRiskPct > 0 && latestSimAccount?.balance) {
    size = Math.min(size, (latestSimAccount.balance * maxRiskPct) / 100);
  }
  size = Math.max(size, minPositionSol);
  size = Math.min(size, maxPositionSol);
  return size;
}

// ── Close Position ─────────────────────────────────────────────────────────

export async function closePositionById(
  id: number,
  reason: CloseReason,
  detailOverride?: string,
): Promise<void> {
  const pos = _latestPositions.get(id);
  if (!pos || pos.status === "closed" || pos.status === "closing") return;

  patchPosition(id, { status: "closing", closeReason: reason });

  try {
    if (CONFIG.liveMode) {
      await liveSell(pos.pair);
    } else {
      const balanceNum = 1; // Sell full position
      await simSell(pos.pair, 1);
    }

    patchPosition(id, {
      currentProfitPercent: pos.currentProfitPercent,
      currentProfitUsd: pos.currentProfitUsd,
    });

    // Fetch final PnL for simulator
    if (!CONFIG.liveMode) {
      const finalData = await fetchFinalPnL(pos.token);
      if (finalData) {
        patchPosition(id, {
          currentProfitPercent: finalData.profitPct,
          currentProfitUsd: finalData.profitUsd,
          exitPriceUsd: finalData.exitPriceUsd,
        });
      }
    }
  } catch (err) {
    console.error(`[BOT] Failed to sell ${pos.tokenName}:`, err);
  }

  const latest = _latestPositions.get(id) ?? pos;
  const final: PositionState = {
    ...latest,
    status: "closed",
    closeReason: reason,
    lastUpdateAt: Date.now(),
  };
  upsertPosition(final);
  unsubscribePair(pos.pair);
  const detail = detailOverride ?? `Closed via ${reason}`;
  emitEvent({ type: "closed", position: final, closeReason: reason, detail });
  refreshAccount$.next();
  _pnlPeakMap.delete(id);

  if (final.currentProfitPercent < 0) {
    _consecutiveLosses++;
    _dailyLossUsd += final.currentProfitUsd;
  }
}

async function fetchFinalPnL(
  tokenAddress: string,
): Promise<{
  profitPct: number;
  profitUsd: number;
  exitPriceUsd: number | null;
} | null> {
  for (let i = 0; i < 10; i++) {
    try {
      const pairs = await fetchTradePairs(false);
      const pair = pairs.find((p) => p.tokenInfo0.contract === tokenAddress);
      if (pair) {
        const sellAmount = Number(pair.sellTokenAmount);
        const hasSellData = sellAmount > 0 && pair.sellReceiveUsd > 0;
        let profitPct = pair.fullProfitPercent * 100;
        let profitUsd = pair.fullProfitUsd;
        let exitPriceUsd: number | null = null;
        if (hasSellData) exitPriceUsd = pair.sellReceiveUsd / sellAmount;
        return { profitPct, profitUsd, exitPriceUsd };
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

export async function closePosition(
  pair: string,
  reason: CloseReason,
): Promise<void> {
  let oldestId: number | undefined;
  let oldestTime = Infinity;
  for (const [pid, p] of _latestPositions) {
    if (
      p.pair === pair &&
      (p.status === "open" || p.status === "closing") &&
      p.openedAt < oldestTime
    ) {
      oldestTime = p.openedAt;
      oldestId = pid;
    }
  }
  if (oldestId !== undefined) await closePositionById(oldestId, reason);
}

// ── Signal Processing ──────────────────────────────────────────────────────

// Subscribe to accepted signals (with pause support)
acceptedSignal$
  .pipe(
    withLatestFrom(openPositions$, signalPaused$),
    filter(([, , paused]) => !paused),
    concatMap(async ([signal, open]) => {
      if (open.length >= CONFIG.maxPositions) {
        console.log(
          `[BOT] Max positions (${CONFIG.maxPositions}) reached — skipping ${signal.tokenName}`,
        );
        return;
      }
      await openPosition(signal);
    }),
  )
  .subscribe();

expiredPair$.subscribe((pairs: any) => {
  for (const pair of pairs) unsubscribePair(pair);
});

// ── Price Tracking ─────────────────────────────────────────────────────────

priceUpdate$
  .pipe(
    withLatestFrom(openPositions$),
    tap(([update, positions]) => {
      for (const pos of positions) {
        if (
          pos.pair !== update.pair ||
          !update.priceUsd ||
          update.priceUsd <= 0
        )
          continue;
        if (!pos.entryPriceUsd) {
          patchPosition(pos.id, {
            entryPriceUsd: update.priceUsd,
            peakPriceUsd: update.priceUsd,
          });
        }
        if (update.priceUsd > pos.peakPriceUsd) {
          pos.peakPriceUsd = update.priceUsd;
        }
        const profitPct =
          (update.priceUsd - pos.entryPriceUsd!) / pos.entryPriceUsd!;
        const profitUsd = profitPct * pos.sizeSol;
        patchPosition(pos.id, {
          currentProfitPercent: profitPct,
          currentProfitUsd: profitUsd,
        });
      }
    }),
  )
  .subscribe();

// ── Client-Side Trailing Stop (SIMULATE mode only) ────────────────────────

if (!CONFIG.liveMode) {
  priceUpdate$
    .pipe(
      withLatestFrom(openPositions$),
      filter(
        () =>
          CONFIG.trailingDistancePct > 0 || CONFIG.trailingTpDistancePct > 0,
      ),
      tap(([update, positions]) => {
        for (const pos of positions) {
          if (pos.pair !== update.pair || !pos.entryPriceUsd) continue;
          const pnlFraction =
            (update.priceUsd - pos.entryPriceUsd) / pos.entryPriceUsd;
          const prevPeak = _pnlPeakMap.get(pos.id) ?? pnlFraction;
          if (pnlFraction > prevPeak) _pnlPeakMap.set(pos.id, pnlFraction);

          // Trailing TP
          if (
            CONFIG.trailingTpDistancePct > 0 &&
            prevPeak > 0 &&
            pnlFraction < prevPeak - CONFIG.trailingTpDistancePct
          ) {
            closePositionById(pos.id, "take_profit").catch(() => {});
          }
          // Trailing stop
          if (
            CONFIG.trailingDistancePct > 0 &&
            prevPeak > CONFIG.trailingActivationPct &&
            pnlFraction < prevPeak - CONFIG.trailingDistancePct
          ) {
            closePositionById(pos.id, "trailing_stop").catch(() => {});
          }
          // Hard stop loss
          if (
            CONFIG.stopLossPct < 0 &&
            pnlFraction < CONFIG.stopLossPct &&
            pnlFraction > -0.999
          ) {
            closePositionById(pos.id, "stop_loss").catch(() => {});
          }
          // Hard take profit
          if (CONFIG.backstopTpPct > 0 && pnlFraction >= CONFIG.backstopTpPct) {
            closePositionById(pos.id, "take_profit").catch(() => {});
          }
        }
      }),
    )
    .subscribe();
}

// ── LIVE: Trade WS Events ──────────────────────────────────────────────────

if (CONFIG.liveMode) {
  buySuccessEvent$.subscribe((event: any) => {
    const pos = findPosByOrderId(event.result.id);
    if (pos && !pos.entryPriceUsd && event.result.priceUsd) {
      patchPosition(pos.id, {
        entryPriceUsd: event.result.priceUsd,
        peakPriceUsd: event.result.priceUsd,
      });
      _pendingBuys.delete(pos.token);
    }
  });

  const closeFromWs = (event: any, reason: CloseReason) => {
    const pos = findPosByOrderId(event.result.id);
    if (pos) {
      _pendingBuys.delete(pos.token);
      const final = {
        ...pos,
        status: "closed" as const,
        closeReason: reason,
        exitPriceUsd: event.result.priceUsd ?? null,
        lastUpdateAt: Date.now(),
      };
      upsertPosition(final);
      unsubscribePair(pos.pair);
      emitEvent({
        type: "closed",
        position: final,
        closeReason: reason,
        detail: `WS: ${reason}`,
      });
      refreshAccount$.next();
      _pnlPeakMap.delete(pos.id);
    }
  };

  sellSuccessEvent$.subscribe((e: any) => closeFromWs(e, "manual"));
  tpSuccessEvent$.subscribe((e: any) => closeFromWs(e, "take_profit"));
  slSuccessEvent$.subscribe((e: any) => closeFromWs(e, "stop_loss"));
}

function findPosByOrderId(orderId: string): PositionState | undefined {
  for (const pos of _latestPositions.values()) {
    if (pos.orderId === orderId) return pos;
  }
  return undefined;
}

// ── TTL Checker ────────────────────────────────────────────────────────────

timer(CONFIG.expiryCheckMs, CONFIG.expiryCheckMs)
  .pipe(
    withLatestFrom(openPositions$),
    tap(([, positions]) => {
      const now = Date.now();
      const maxAge = CONFIG.maxTtlSecs * 1000;
      for (const pos of positions) {
        if (pos.status !== "open") continue;
        if (now - pos.openedAt >= maxAge) {
          closePositionById(pos.id, "expired").catch(() => {});
          continue;
        }
        if (now < pos.expiresAt) continue;
        if (
          CONFIG.minProfitForTtlExtensionPct > 0 &&
          pos.currentProfitPercent >= CONFIG.minProfitForTtlExtensionPct
        ) {
          patchPosition(pos.id, { expiresAt: now + CONFIG.baseTtlSecs * 1000 });
          continue;
        }
        closePositionById(pos.id, "expired").catch(() => {});
      }
    }),
  )
  .subscribe();

// ── Simulator: PnL Task Polling (DEPRECATED — keeping as fallback) ────────

// We no longer poll PnL tasks since we use client-side exits.
// But if positions were created with server-side tasks (from old code),
// we still poll them.
startSimPnLPoll(openOrderIds$, (orderId, tasks) => {
  if (tasks.length === 0) return;
  const pos = findPosByOrderId(orderId);
  if (!pos || pos.status !== "open") return;
  const hasStopLoss = tasks.some(
    (t) => t.state === "done" && t.triggerDirection === "down",
  );
  const hasTakeProfit = tasks.some(
    (t) => t.state === "done" && t.triggerDirection === "up",
  );
  const anyTerminal = tasks.some(
    (t) => t.state === "done" || t.state === "fail" || t.state === "expired",
  );
  const anyInit = tasks.some((t) => t.state === "init");
  if (hasStopLoss) closePositionById(pos.id, "stop_loss").catch(() => {});
  else if (anyTerminal && !anyInit) {
    const reason: CloseReason = hasTakeProfit ? "take_profit" : "expired";
    closePositionById(pos.id, reason).catch(() => {});
  }
});

// ── Simulator: Trade Pair Polling (DEPRECATED — keeping as fallback) ───────

startSimPairPoll(openPositions$, (pair: any) => {
  const token = pair.tokenInfo0.contract;
  for (const pos of _latestPositions.values()) {
    if (pos.status !== "open" || pos.token !== token) continue;
    patchPosition(pos.id, {
      remainingBalance: pair.token0Balance,
      currentProfitPercent: pair.fullProfitPercent * 100,
      currentProfitUsd: pair.fullProfitUsd,
    });
    const balanceNum = Number(pair.token0Balance);
    if (balanceNum <= 0) {
      const reason: CloseReason =
        pair.sellProfitPercent !== null && pair.sellProfitPercent < 0
          ? "stop_loss"
          : "take_profit";
      closePositionById(pos.id, reason).catch(() => {});
    }
  }
});

// ── REST Price Polling (fallback) ─────────────────────────────────────────

startRestPricePolling(openPositions$);

// ── Report Generation ──────────────────────────────────────────────────────

let _consecutiveLosses = 0;
let _dailyLossUsd = 0;
let _paperBalanceSol = 5;
let _paperRealizedPnLSol = 0;
let _paperWins = 0;
let _paperLosses = 0;

// Track paper PnL from events
positionClosed$
  .pipe(
    filter(
      (ev: any) =>
        CONFIG.liveMode &&
        !CONFIG.liveBuyEnabled &&
        ev.position?.orderId?.startsWith("paper_"),
    ),
  )
  .subscribe((ev: any) => {
    const p = ev.position;
    const pnlSol = p.currentProfitUsd ?? 0;
    const cost = p.sizeSol;
    const exitPrice = p.exitPriceUsd ?? p.entryPriceUsd;
    const pnlPct =
      exitPrice && p.entryPriceUsd
        ? (exitPrice - p.entryPriceUsd) / p.entryPriceUsd
        : p.currentProfitPercent;
    const pnl = pnlPct * cost;
    _paperBalanceSol += cost + pnl;
    _paperRealizedPnLSol += pnl;
    if (pnl >= 0) _paperWins++;
    else _paperLosses++;
  });

export function getReport(): PerformanceReport {
  let totalProfitUsd = 0;
  let totalCostUsd = 0;
  let wins = 0;
  let losses = 0;
  let bestPct = 0;
  let worstPct = 0;
  let avgCount = 0;
  let totalPct = 0;
  const reasons: Record<string, number> = {};
  let openCount = 0;

  for (const pos of _latestPositions.values()) {
    if (pos.status === "closed") {
      totalProfitUsd += pos.currentProfitUsd;
      totalCostUsd += pos.sizeSol;
      if (pos.currentProfitPercent > 0) wins++;
      else if (pos.currentProfitPercent < 0) losses++;
      if (avgCount === 0 || pos.currentProfitPercent > bestPct)
        bestPct = pos.currentProfitPercent;
      if (avgCount === 0 || pos.currentProfitPercent < worstPct)
        worstPct = pos.currentProfitPercent;
      totalPct += pos.currentProfitPercent;
      avgCount++;
      if (pos.closeReason)
        reasons[pos.closeReason] = (reasons[pos.closeReason] ?? 0) + 1;
    }
    if (pos.status === "open" || pos.status === "closing") openCount++;
  }

  const closedCount = wins + losses;
  const total = closedCount + openCount;

  return {
    totalPositions: total,
    closedPositions: closedCount,
    openPositions: openCount,
    winningTrades: wins,
    losingTrades: losses,
    winRate: closedCount > 0 ? (wins / closedCount) * 100 : 0,
    totalProfitUsd,
    totalProfitPct:
      totalCostUsd > 0 ? (totalProfitUsd / totalCostUsd) * 100 : 0,
    avgProfitPct: avgCount > 0 ? totalPct / avgCount : 0,
    avgProfitUsd: closedCount > 0 ? totalProfitUsd / closedCount : 0,
    bestTradePct: bestPct,
    worstTradePct: worstPct,
    reasons,
  };
}

export function getBalanceStr(): string {
  if (!CONFIG.liveMode && latestSimAccount) {
    const change = latestSimAccount.changeAll;
    const icon = change >= 0 ? "\u{1F7E2}" : "\u{1F534}";
    const sign = change >= 0 ? "+" : "";
    return `${icon} \u{1F4B0} Balance: \`$${latestSimAccount.balance.toFixed(2)}\` (\`${sign}${(change * 100).toFixed(2)}%\`)`;
  }
  return "";
}

export function getPaperBalanceSol(): number {
  return _paperBalanceSol;
}
export function getPaperRealizedPnLSol(): number {
  return _paperRealizedPnLSol;
}

// ── Recovery ───────────────────────────────────────────────────────────────

export async function recoverOpenPositions(): Promise<void> {
  if (CONFIG.liveMode) return; // Live positions managed via WS/DB

  try {
    const pairs = await fetchTradePairs(true);
    const now = Date.now();
    for (const p of pairs) {
      const entryPriceUsd =
        p.costUsd > 0 && Number(p.buyTokenAmount) > 0
          ? p.costUsd / Number(p.buyTokenAmount)
          : null;
      const pos: PositionState = {
        id: _nextId++,
        orderId: p._id,
        pair: p._id,
        token: p.tokenInfo0.contract,
        tokenName: p.tokenInfo0.name ?? p.tokenInfo0.symbol ?? "unknown",
        tokenSymbol: p.tokenInfo0.symbol ?? "",
        entryPriceUsd,
        entryCostUsd: p.costUsd,
        sizeSol: Number(p.buyTokenAmount) || 0,
        filledSol: 0,
        avgFillPriceUsd: null,
        peakPriceUsd: 0,
        trailingActive: false,
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
          chain: "solana",
        },
      };
      upsertPosition(pos);
    }
    if (pairs.length > 0) {
      subscribePairs(
        pairs.map((p) => ({ pair: p._id, token: p.tokenInfo0.contract })),
      );
    }
  } catch (err) {
    console.error("[BOT] Recovery failed:", err);
  }
}

// ── Start / Stop ───────────────────────────────────────────────────────────

let _initialized = false;

export function startBot(): void {
  if (_initialized) return;
  _initialized = true;

  wireReporter({
    getReport,
    getBalanceStr,
    openPositions$,
    positionEvent$,
    positionClosed$,
  });

  console.log(`[BOT] Started in ${CONFIG.liveMode ? "LIVE" : "SIMULATE"} mode`);
}
