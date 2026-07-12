import { Bot } from "grammy";
import { convert } from "telegram-markdown-v2";
import { Subscription } from "rxjs";

import { CONFIG } from "./config";
import { telegramSignal$ } from "./telegram/telegram_client";
import { positionExitRequested$ } from "./strategy/scanner";
import {
  addPosition,
  removePosition,
  hasPosition,
  positionUpdated$,
} from "./strategy/positions_store";
import { trackToken, untrackToken } from "./data_stream/price_engine";
import { PositionExitReason, type Position } from "./strategy/types";
import type { AveScannerSignal } from "./telegram/ave_scanner_parser";
import type { ExitCheckResult } from "./strategy/exit-strategies/types";
import { simulatorTrading } from "./trading/simulator/simulator";

/* -------------------------------------------------------------------------- */
/*                                   State                                    */
/* -------------------------------------------------------------------------- */

const DEBUG = CONFIG.logLevel === "debug";

let bot: Bot | null = null;
let signalSub: Subscription | null = null;
let exitSub: Subscription | null = null;
let debugSub: Subscription | null = null;

/** Prevents duplicate buys for the same pair while a buy is in-flight. */
const pendingBuyPairs = new Set<string>();

const LIVE_SIM_START = 10;
let initialSimBalance = 0;

function getLiveBalance(simBalance: number): number {
  if (initialSimBalance <= 0) return LIVE_SIM_START;
  return (simBalance / initialSimBalance) * LIVE_SIM_START;
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

  const lines: string[] = [
    `📊 **Trade Report \\(last ${total}\\)**`,
    `━━━━━━━━━━━━━━━━━━━`,
    `Trades: \`${total}\``,
    `Win rate: \`${(winRate * 100).toFixed(0)}%\``,
    `Avg winner: \`${fmtPct(avgWin)}\``,
    `Avg loser: \`${fmtPct(avgLoss)}\``,
    `Profit factor: \`${profitFactor.toFixed(2)}\``,
    `Expectancy: \`${expectancy >= 0 ? "+" : ""}${expectancy.toFixed(2)}R\``,
    `Median hold: \`${fmtDuration(medianDurationMs)}\``,
    ``,
    `Best: \`${best.tokenName}\` ${fmtPct(best.pnl)}`,
    `Worst: \`${worst.tokenName}\` ${fmtPct(worst.pnl)}`,
    ``,
    ...Object.entries(exitTypes)
      .sort(([, a], [, b]) => b - a)
      .map(
        ([label, count]) =>
          `${label}: \`${((count / total) * 100).toFixed(0)}%\``,
      ),
  ];

  if (avgMcap > 0) {
    lines.push(`Avg MCap: \`${fmtMcap(avgMcap)}\``);
  }

  lines.push(`━━━━━━━━━━━━━━━━━━━`);

  sendTelegram(lines.join("\n"));
  console.log("[SimTrading] Report sent");
}

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

function fmtPrice(price: number): string {
  if (price >= 1) return `$${price.toFixed(4)}`;
  if (price >= 0.001) return `$${price.toFixed(6)}`;
  if (price >= 0.000001) return `$${price.toFixed(9)}`;
  return `$${price.toFixed(12)}`;
}

function fmtPct(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(2)}%`;
}

function now(): number {
  return Date.now();
}

function fmtMcap(mcap: number): string {
  if (mcap >= 1e9) return `$${(mcap / 1e9).toFixed(2)}B`;
  if (mcap >= 1e6) return `$${(mcap / 1e6).toFixed(2)}M`;
  if (mcap >= 1e3) return `$${(mcap / 1e3).toFixed(2)}K`;
  return `$${mcap.toFixed(2)}`;
}

function fmtDuration(ms: number): string {
  const totalSecs = Math.floor(ms / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function sendTelegram(text: string): void {
  if (!bot || !CONFIG.telegramChatId) return;

  try {
    const converted = convert(text);
    bot.api.sendMessage(CONFIG.telegramChatId, converted, {
      parse_mode: "MarkdownV2",
    }).catch((err) => {
      console.error("[SimTrading] Failed to send msg:", err);
    });
  } catch (err) {
    console.error("[SimTrading] Failed to convert msg:", err);
  }
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
  const entryPrice = signal.initPriceUSD ?? 0;
  if (entryPrice <= 0) {
    pendingBuyPairs.delete(pair);
    return;
  }

  console.log(
    `[SimTrading] Buy signal: ${tokenName} @ ${fmtPrice(entryPrice)}`,
  );

  try {
    const result = await simulatorTrading.buy(
      pair,
      CONFIG.positionSize,
      tokenName,
      token,
    );
    const fillPrice = result.priceUsd ?? entryPrice;

    addPosition(token, pair, tokenName, fillPrice, CONFIG.positionSize);
    trackToken(token, pair);

    const account = await simulatorTrading.getAccount();

    const lines = [
      `🟢 **Position Opened**`,
      `━━━━━━━━━━━━━━━━━━━`,
      `🔖 Token: \`${tokenName}\``,
      `💵 Entry: \`${fmtPrice(fillPrice)}\``,
      `💰 Size: \`${CONFIG.positionSize} SOL\``,
      `💳 Balance: \`$${account.balance.toFixed(2)}\``,
      `💵 Live: \`$${getLiveBalance(account.balance).toFixed(2)}\``,
    ];

    if (signal.marketCapUSD) {
      lines.push(
        `📊 MCap: \`${fmtMcap(signal.marketCapUSD)}\``,
      );
    }
    if (signal.dex) {
      lines.push(`🏛 Dex: \`${signal.dex}\``);
    }

    sendTelegram(lines.join("\n"));
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

  try {
    const sellResult = await simulatorTrading.sell(
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

      const label = pnl >= 0 ? "🟢" : "🔴";

      const account = await simulatorTrading.getAccount();

      const lines = [
        `${label} **Trade Closed**`,
        `━━━━━━━━━━━━━━━━━━━`,
        `🔖 Token: \`${tokenName}\``,
        `📈 PnL: **${fmtPct(pnl)}**`,
        `💵 Entry: \`${fmtPrice(closed.entryPriceUsd)}\``,
        `💵 Exit: \`${fmtPrice(closePrice)}\``,
        `💰 Size: \`${closed.sizeSol} SOL\``,
        `💳 Balance: \`$${account.balance.toFixed(2)}\``,
        `💵 Live: \`$${getLiveBalance(account.balance).toFixed(2)}\``,
        `📋 Reason: \`${reasonToLabel(reason)}\``,
        `⏱ Duration: \`${fmtDuration(durationMs)}\``,
        `━━━━━━━━━━━━━━━━━━━`,
      ];

      sendTelegram(lines.join("\n"));

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

export async function startSimulatedTrading(): Promise<void> {
  if (signalSub) return;

  if (CONFIG.telegramBotToken && CONFIG.telegramChatId) {
    bot = new Bot(CONFIG.telegramBotToken);
    console.log("[SimTrading] Bot initialized");
  }

  try {
    const acc = await simulatorTrading.getAccount();
    initialSimBalance = acc.balance;
    console.log(
      `[SimTrading] Live sim: $${LIVE_SIM_START} → sim $${acc.balance.toFixed(2)}`,
    );
  } catch {
    console.warn("[SimTrading] Could not fetch initial balance");
  }

  signalSub = telegramSignal$.subscribe(onSignal);
  exitSub = positionExitRequested$.subscribe(onExit);

  if (DEBUG) {
    debugSub = positionUpdated$.subscribe(onPositionUpdate);
  }

  console.log("[SimTrading] Started");
}

export function stopSimulatedTrading(): void {
  signalSub?.unsubscribe();
  exitSub?.unsubscribe();
  debugSub?.unsubscribe();

  signalSub = null;
  exitSub = null;
  debugSub = null;

  bot = null;

  console.log("[SimTrading] Stopped");
}
