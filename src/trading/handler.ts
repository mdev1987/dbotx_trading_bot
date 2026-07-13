import { Subscription } from "rxjs";

import { CONFIG } from "../config";
import { telegramSignal$ } from "../telegram/telegram_client";
import { positionExitRequested$ } from "../strategy/scanner";
import {
  addPosition,
  removePosition,
  hasPosition,
  positionUpdated$,
} from "../strategy/positions_store";
import { trackToken, untrackToken, getSolPriceUsd } from "../data_stream/price_engine";
import { PositionExitReason, type Position } from "../strategy/types";
import type { AveScannerSignal } from "../telegram/ave_scanner_parser";
import type { ExitCheckResult } from "../strategy/exit-strategies/types";
import type { TradingApi } from "./types";
import { sendTelegram, fmtPrice, fmtPct, fmtMcap, fmtDuration, notifyBuyOpened, notifyTradeClosed, sendTradeReport } from "../telegram/telegram_bot";

/* -------------------------------------------------------------------------- */
/*                                   State                                    */
/* -------------------------------------------------------------------------- */

const DEBUG = CONFIG.logLevel === "debug";

let signalSub: Subscription | null = null;
let exitSub: Subscription | null = null;
let debugSub: Subscription | null = null;

/** Prevents duplicate buys for the same pair while a buy is in-flight. */
const pendingBuyPairs = new Set<string>();

/** Trading backend — set by startTrading. */
let trading: TradingApi | null = null;

const LIVE_SIM_START = 10;
let initialSimBalance = 0;

/** Total equity scaled to $10 (includes open positions). Only moves on PnL. */
function getLiveCash(simBalance: number): number {
  const base = initialSimBalance > 0 ? initialSimBalance : 10000;
  return (simBalance / base) * LIVE_SIM_START;
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

const MAX_REALISTIC_PNL = 10;

const completedTrades: TradeRecord[] = [];

let lastSignalMeta: { marketCapUSD?: number; dex?: string } = {};

function recordTrade(
  closed: NonNullable<ReturnType<typeof removePosition>>,
  closePrice: number,
  reason: PositionExitReason,
): void {
  const pnl = (closePrice - closed.entryPriceUsd) / closed.entryPriceUsd;
  if (reason === PositionExitReason.PartialTP) return;

  completedTrades.push({
    tokenName: closed.tokenName,
    entryPriceUsd: closed.entryPriceUsd,
    exitPriceUsd: closePrice,
    pnl,
    durationMs: now() - closed.openedAt,
    reason,
    ...lastSignalMeta,
  });

  if (completedTrades.length >= 100) sendTradeReport();
}

function sendTradeReport(): void {
  const bucket = completedTrades.splice(0, 100);
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

  const sortedDurations = bucket
    .map((t) => t.durationMs)
    .sort((a, b) => a - b);
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
  );

  console.log("[SimTrading] Report sent");
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

  lastSignalMeta = { marketCapUSD: signal.marketCapUSD, dex: signal.dex };

  const tokenName = signal.Token ?? token.slice(0, 8);
  const entryPrice = signal.initPriceUSD;
  console.log(
    `[SimTrading] Buy signal: ${tokenName}${entryPrice ? ` @ ${fmtPrice(entryPrice)}` : " (no price)"}`,
  );

  if (!trading) return;

  try {
    const result = await trading.buy(
      pair,
      CONFIG.positionSize,
      tokenName,
      token,
    );
    const fillPrice = result.priceUsd ?? entryPrice;

    if (!fillPrice || fillPrice <= 0) {
      console.log(`[SimTrading] Skipping ${tokenName} — no valid price`);
      pendingBuyPairs.delete(pair);
      return;
    }

    const position = addPosition(token, pair, tokenName, fillPrice, CONFIG.positionSize);
    if (!position) {
      console.log(`[SimTrading] Skipping ${tokenName} — addPosition failed`);
      pendingBuyPairs.delete(pair);
      return;
    }
    trackToken(token, pair);
      const account = await trading.getAccount();

    if (initialSimBalance === 0) {
      initialSimBalance = account.balance;
    }

    notifyBuyOpened(
      tokenName,
      fillPrice,
      CONFIG.positionSize,
      account.balance,
      signal.marketCapUSD,
      signal.dex,
    );
  } catch (err) {
    console.error(`[SimTrading] Buy failed for ${tokenName}:`, err);
    untrackToken(token);
  } finally {
    pendingBuyPairs.delete(pair);
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
    `[SimTrading] Exit: ${tokenName} reason=${reason} pct=${(sellPct * 100).toFixed(0)}%`,
  );

  if (!trading) return;

  try {
    const sellResult = await trading.sell(
      pair,
      sellPct,
      tokenName,
      token,
    );
    const closePrice = sellResult.priceUsd ?? position.currentPriceUsd;

    const closed = removePosition(pair, closePrice, reason);

    if (closed) {
      const pnl =
        (closePrice - closed.entryPriceUsd) / closed.entryPriceUsd;
      const durationMs = now() - closed.openedAt;

      const isBogus =
        Math.abs(pnl) > MAX_REALISTIC_PNL && durationMs < 60000;

      if (isBogus) {
        console.warn(
          `[SimTrading] Bogus PnL for ${tokenName}: ${fmtPct(pnl)} in ${fmtDuration(durationMs)} — discarded`,
        );
        if (reason !== PositionExitReason.PartialTP) {
          untrackToken(token);
        }
        return;
      }

      recordTrade(closed, closePrice, reason);

      const account = await trading.getAccount();

      notifyTradeClosed(
        tokenName,
        pnl,
        closed.entryPriceUsd,
        closePrice,
        closed.sizeSol,
        account.balance,
        reasonToLabel(reason),
        durationMs,
      );

      if (reason !== PositionExitReason.PartialTP) {
        untrackToken(token);
      }
    }
  } catch (err) {
    console.error(`[SimTrading] Sell failed for ${tokenName}:`, err);
  }
}

/* -------------------------------------------------------------------------- */
/*                                Debug logging                               */
/* -------------------------------------------------------------------------- */

function onPositionUpdate(position: Position): void {
  if (!DEBUG) return;
  const pnl = fmtPct(position.currentProfitPct);
  console.log(
    `[SimTrading] ${position.tokenName}: ${fmtPrice(position.currentPriceUsd)} pnl=${pnl}`,
  );
}

/* -------------------------------------------------------------------------- */
/*                                Lifecycle                                   */
/* -------------------------------------------------------------------------- */

export async function startTrading(api: TradingApi): Promise<void> {
  if (signalSub) return;

  trading = api;

  console.log(
    `[SimTrading] Live sim: $${LIVE_SIM_START}`,
  );

  signalSub = telegramSignal$.subscribe(onSignal);
  exitSub = positionExitRequested$.subscribe(onExit);

  if (DEBUG) {
    debugSub = positionUpdated$.subscribe(onPositionUpdate);
  }

  console.log("[SimTrading] Started");
}

export function stopTrading(): void {
  signalSub?.unsubscribe();
  exitSub?.unsubscribe();
  debugSub?.unsubscribe();

  signalSub = null;
  exitSub = null;
  debugSub = null;

  console.log("[SimTrading] Stopped");
}
