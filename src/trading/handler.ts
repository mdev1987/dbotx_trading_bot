import { Subscription } from "rxjs";

import { CONFIG } from "../config";
import {
  dequeueSignal,
  queueSize,
  signalQueued$,
} from "../telegram/telegram_signal_queue";
import { positionExitRequested$, clearPendingExit } from "../strategy/scanner";
import {
  addPosition,
  removePosition,
  hasPosition,
  positionUpdated$,
  positions,
} from "../strategy/positions_store";
import { trackToken, untrackToken } from "../data_stream/price_engine";
import { PositionExitReason, type Position } from "../strategy/types";
import type { AveScannerSignal } from "../telegram/ave_scanner_parser";
import type { ExitCheckResult } from "../strategy/exit-strategies/types";
import type { TradingApi } from "./types";
import {
  sendTelegram,
  fmtPrice,
  fmtPct,
  fmtMcap,
  fmtDuration,
  notifyBuyOpened,
  notifyTradeClosed,
  sendTradeReport,
} from "../telegram/telegram_bot";

/* -------------------------------------------------------------------------- */
/*                                   State                                    */
/* -------------------------------------------------------------------------- */

const DEBUG = CONFIG.logLevel === "debug";

let signalSub: Subscription | null = null;
let exitSub: Subscription | null = null;
let debugSub: Subscription | null = null;

/** Prevents duplicate buys for the same pair while a buy is in-flight. */
const pendingBuyPairs = new Set<string>();

/** Circuit breaker: pause trading after N consecutive losses. */
const MAX_CONSECUTIVE_LOSSES = 5;
let consecutiveLosses = 0;
let circuitBreakerTrippedAt = 0;
const CIRCUIT_BREAKER_COOLDOWN_MS = 300_000;

function isCircuitBreakerTripped(): boolean {
  if (circuitBreakerTrippedAt === 0) return false;
  if (Date.now() - circuitBreakerTrippedAt > CIRCUIT_BREAKER_COOLDOWN_MS) {
    console.log("[Handler] Circuit breaker reset after cooldown");
    circuitBreakerTrippedAt = 0;
    consecutiveLosses = 0;
    return false;
  }
  return true;
}

/** Trading backend — set by startTrading. */
let trading: TradingApi | null = null;

function getPositionStats(): { open: number; total: number; winRate: number } {
  const open = positions.size;
  const closed = completedTrades.length;
  const wins = completedTrades.filter((t) => t.pnl >= 0).length;
  const winRate = closed > 0 ? wins / closed : 0;
  // return { open, total: open + closed, winRate };
  return { open, total: CONFIG.maxOpenPositions, winRate };
}

/* -------------------------------------------------------------------------- */
/*                          Trade Stats & Reporting                           */
/* -------------------------------------------------------------------------- */

interface TradeRecord {
  tokenName: string;
  entryPriceUsd: number;
  exitPriceUsd: number;
  pnl: number;
  durationMs: number;
  reason: PositionExitReason;
  marketCapUSD?: number;
  dex?: string;
}

const completedTrades: TradeRecord[] = [];

function recordTrade(
  closed: NonNullable<ReturnType<typeof removePosition>>,
  closePrice: number,
  reason: PositionExitReason,
): void {
  const pnl = (closePrice - closed.entryPrice) / closed.entryPrice;
  if (reason === PositionExitReason.PartialTP) return;

  completedTrades.push({
    tokenName: closed.tokenName,
    entryPriceUsd: closed.entryPrice,
    exitPriceUsd: closePrice,
    pnl,
    durationMs: now() - closed.openedAt,
    reason,
    ...closed.signalMeta,
  });

  if (completedTrades.length >= CONFIG.tradeReportBatchSize)
    flushTradeReportBatch();
}

function flushTradeReportBatch(): void {
  const bucket = completedTrades.splice(0, CONFIG.tradeReportBatchSize);
  const total = bucket.length;
  if (total === 0) return;

  const wins = bucket.filter((t) => t.pnl >= 0);
  const losses = bucket.filter((t) => t.pnl < 0);
  const winRate = wins.length / total;

  const avgWin = wins.length
    ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length
    : 0;
  const avgLoss = losses.length
    ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length
    : 0;

  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : 0;

  const avgLossAbs = Math.abs(avgLoss);
  const expectancy =
    avgLossAbs > 0
      ? winRate * (avgWin / avgLossAbs) - (1 - winRate)
      : winRate * avgWin;

  const sortedDurations = bucket.map((t) => t.durationMs).sort((a, b) => a - b);
  const mid = Math.floor(sortedDurations.length / 2);
  const medianDurationMs: number =
    sortedDurations.length % 2 === 0
      ? (sortedDurations[mid - 1]! + sortedDurations[mid]!) / 2
      : sortedDurations[mid]!;

  const best = bucket.reduce((a, b) => (a.pnl > b.pnl ? a : b));
  const worst = bucket.reduce((a, b) => (a.pnl < b.pnl ? a : b));

  const exitTypes: Record<string, number> = {};
  for (const t of bucket) {
    const label = reasonToLabel(t.reason);
    exitTypes[label] = (exitTypes[label] || 0) + 1;
  }

  const avgMcaps = bucket
    .filter((t) => t.marketCapUSD !== undefined)
    .map((t) => t.marketCapUSD!);
  const avgMcap =
    avgMcaps.length > 0
      ? avgMcaps.reduce((s, v) => s + v, 0) / avgMcaps.length
      : 0;

  sendTradeReport(
    total,
    winRate,
    avgWin,
    avgLoss,
    profitFactor,
    expectancy,
    medianDurationMs,
    { tokenName: best.tokenName, pnl: best.pnl },
    { tokenName: worst.tokenName, pnl: worst.pnl },
    exitTypes,
    avgMcap,
    positions.size,
    queueSize(),
  );

  console.log("[Handler] Report sent");
}

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

function now(): number {
  return Date.now();
}

function reasonToLabel(reason: PositionExitReason): string {
  switch (reason) {
    case PositionExitReason.StopLoss:
      return "Stop Loss";
    case PositionExitReason.TrailingStop:
      return "Trailing Stop";
    case PositionExitReason.Expired:
      return "Expired (TTL)";
    case PositionExitReason.PartialTP:
      return "Partial TP";
    case PositionExitReason.TakeProfit:
      return "Take Profit";
    case PositionExitReason.Manual:
      return "Manual";
  }
}

/* -------------------------------------------------------------------------- */
/*                              Signal → Buy                                  */
/* -------------------------------------------------------------------------- */

async function onSignal(signal: AveScannerSignal): Promise<void> {
  const token = signal.CA;
  const pair = signal.LP;
  if (!token || !pair) return;

  if (hasPosition(pair) || pendingBuyPairs.has(pair)) return;

  pendingBuyPairs.add(pair);

  const signalMeta = { marketCapUSD: signal.marketCapUSD, dex: signal.dex };
  const tokenName = signal.Token ?? token.slice(0, 8);
  console.log(`[Handler] Buy signal: ${tokenName}`);

  if (!trading) return;

  try {
    const result = await trading.buy(
      pair,
      CONFIG.positionSize,
      tokenName,
      token,
    );

    const priceCurrency: "SOL" | "USD" =
      CONFIG.tradingEngine === "dbotx" ? "USD" : "SOL";

    const position = addPosition(
      token,
      pair,
      tokenName,
      0,
      CONFIG.positionSize,
      signalMeta,
      priceCurrency,
    );
    if (!position) {
      console.log(`[Handler] Skipping ${tokenName} — addPosition failed`);
      pendingBuyPairs.delete(pair);
      return;
    }
    trackToken(token, pair);
    const account = await trading.getAccount();

    const stats = getPositionStats();
    notifyBuyOpened(
      tokenName,
      CONFIG.positionSize,
      account.balance,
      account.currency,
      signal.marketCapUSD,
      signal.dex,
      stats.open,
      stats.total,
      stats.winRate,
      priceCurrency,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Handler] Buy failed for ${tokenName}:`, err);
    sendTelegram(
      `🔴 **Buy Failed**\n━━━━━━━━━━━━━━━━━━━\n🔖 Token: \`${tokenName}\`\n❌ Error: \`${msg}\``,
    );
    untrackToken(token);
  } finally {
    pendingBuyPairs.delete(pair);
  }
}

function processNextSignal(): void {
  if (isCircuitBreakerTripped()) {
    console.warn("[Handler] Circuit breaker active — skipping signals");
    return;
  }

  if (
    CONFIG.maxOpenPositions > 0 &&
    positions.size >= CONFIG.maxOpenPositions
  ) {
    return;
  }

  const queued = dequeueSignal();
  if (queued) {
    onSignal(queued.signal);
  }
}

/* -------------------------------------------------------------------------- */
/*                              Exit → Sell                                   */
/* -------------------------------------------------------------------------- */

async function onExit(result: ExitCheckResult): Promise<void> {
  const { position, reason, percentage } = result;
  const sellPct = percentage ?? 1;
  const token = position.token;
  const pair = position.pair;
  const tokenName = position.tokenName;

  console.log(
    `[Handler] Exit: ${tokenName} reason=${reason} pct=${(sellPct * 100).toFixed(0)}%`,
  );

  if (!trading) return;

  try {
    const sellResult = await trading.sell(pair, sellPct, tokenName, token);
    const closePrice = sellResult.price ?? position.currentPrice;

    if (reason === PositionExitReason.PartialTP) {
      position.soldPct = Math.min(1, (position.soldPct ?? 0) + sellPct);
      clearPendingExit(position.id);
      const remainingPct = (1 - position.soldPct) * 100;
      const stats = getPositionStats();
      const wr =
        stats.winRate > 0
          ? ` · Win rate: \`${(stats.winRate * 100).toFixed(0)}%\``
          : "";
      sendTelegram(
        `🟡 **Partial TP**\n━━━━━━━━━━━━━━━━━━━\n🔖 Token: \`${tokenName}\`\n💵 Sold at: \`${fmtPrice(closePrice, position.priceCurrency)}\`\n📊 Sold: \`${(sellPct * 100).toFixed(0)}%\`\n📊 Remaining: \`${remainingPct.toFixed(0)}%\`\n📊 Positions: \`${stats.open}/${stats.total}\`${wr}`,
      );
      return;
    }

    const closed = removePosition(pair, closePrice, reason);

    if (closed) {
      const pnl = (closePrice - closed.entryPrice) / closed.entryPrice;
      const durationMs = now() - closed.openedAt;

      const isBogus =
        Math.abs(pnl) > CONFIG.maxRealisticPnlRatio &&
        durationMs < CONFIG.bogusPnlTimeThresholdMs;

      if (isBogus) {
        console.warn(
          `[Handler] Bogus PnL for ${tokenName}: ${fmtPct(pnl)} in ${fmtDuration(durationMs)} — discarded`,
        );
        untrackToken(token);
        return;
      }

      recordTrade(closed, closePrice, reason);

      // Track consecutive losses for circuit breaker
      if (pnl < 0) {
        consecutiveLosses++;
        if (
          consecutiveLosses >= MAX_CONSECUTIVE_LOSSES &&
          circuitBreakerTrippedAt === 0
        ) {
          circuitBreakerTrippedAt = Date.now();
          console.warn(
            `[Handler] Circuit breaker tripped after ${consecutiveLosses} consecutive losses — pausing for ${CIRCUIT_BREAKER_COOLDOWN_MS / 1000}s`,
          );
          sendTelegram(
            `🔴 **Circuit Breaker Tripped**\n━━━━━━━━━━━━━━━━━━━\n📊 ${consecutiveLosses} consecutive losses\n⏸️ Pausing for ${CIRCUIT_BREAKER_COOLDOWN_MS / 60_000} min`,
          );
        }
      } else {
        consecutiveLosses = Math.max(0, consecutiveLosses - 1);
      }

      const account = await trading.getAccount();

      const stats = getPositionStats();
      notifyTradeClosed(
        tokenName,
        pnl,
        closed.entryPrice,
        closePrice,
        closed.peakPrice,
        closed.sizeSol,
        account.balance,
        account.currency,
        reasonToLabel(reason),
        durationMs,
        stats.open,
        stats.total,
        stats.winRate,
        closed.priceCurrency,
      );

      untrackToken(token);

      processNextSignal();
    }
  } catch (err) {
    console.error(`[Handler] Sell failed for ${tokenName}:`, err);
    clearPendingExit(position.id);
    processNextSignal();
  }
}

/* -------------------------------------------------------------------------- */
/*                                Debug logging                               */
/* -------------------------------------------------------------------------- */

function onPositionUpdate(position: Position): void {
  if (!DEBUG) return;
  const pnl = fmtPct(position.currentProfitPct);
  console.log(
    `[Handler] ${position.tokenName}: ${fmtPrice(position.currentPrice)} pnl=${pnl}`,
  );
}

/* -------------------------------------------------------------------------- */
/*                                Lifecycle                                   */
/* -------------------------------------------------------------------------- */

export async function startTrading(api: TradingApi): Promise<void> {
  if (trading) return;

  trading = api;

  signalSub = signalQueued$.subscribe(() => processNextSignal());
  exitSub = positionExitRequested$.subscribe(onExit);

  if (DEBUG) {
    debugSub = positionUpdated$.subscribe(onPositionUpdate);
  }

  processNextSignal();

  console.log("[Handler] Started");
}

export function stopTrading(): void {
  signalSub?.unsubscribe();
  exitSub?.unsubscribe();
  debugSub?.unsubscribe();

  signalSub = null;
  exitSub = null;
  debugSub = null;

  console.log("[Handler] Stopped");
}
