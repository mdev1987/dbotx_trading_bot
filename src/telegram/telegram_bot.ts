import { Bot } from "grammy";
import { convert } from "telegram-markdown-v2";
import { CONFIG } from "../config";

/* -------------------------------------------------------------------------- */
/*                                   Bot                                      */
/* -------------------------------------------------------------------------- */

let bot: Bot | null = null;

export function initTelegramBot(): void {
  if (bot) return;
  if (!CONFIG.telegramBotToken) {
    console.warn("[TelegramBot] No token configured");
    return;
  }
  bot = new Bot(CONFIG.telegramBotToken);
  console.log("[TelegramBot] Initialized");
}

export function shutdownTelegramBot(): void {
  bot = null;
}

/* -------------------------------------------------------------------------- */
/*                               Send Message                                 */
/* -------------------------------------------------------------------------- */

export function sendTelegram(text: string): void {
  if (!bot || !CONFIG.telegramChatId) return;
  try {
    const converted = convert(text);
    bot.api.sendMessage(CONFIG.telegramChatId, converted, {
      parse_mode: "MarkdownV2",
    }).catch((err) => {
      console.error("[TelegramBot] Failed to send msg:", err);
    });
  } catch (err) {
    console.error("[TelegramBot] Failed to convert msg:", err);
  }
}

/* -------------------------------------------------------------------------- */
/*                               Formatters                                   */
/* -------------------------------------------------------------------------- */

export function fmtPrice(price: number): string {
  if (price >= 1) return `$${price.toFixed(4)}`;
  if (price >= 0.001) return `$${price.toFixed(6)}`;
  if (price >= 0.000001) return `$${price.toFixed(9)}`;
  return `$${price.toFixed(12)}`;
}

export function fmtPct(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(2)}%`;
}

export function fmtMcap(mcap: number): string {
  if (mcap >= 1e9) return `$${(mcap / 1e9).toFixed(2)}B`;
  if (mcap >= 1e6) return `$${(mcap / 1e6).toFixed(2)}M`;
  if (mcap >= 1e3) return `$${(mcap / 1e3).toFixed(2)}K`;
  return `$${mcap.toFixed(2)}`;
}

export function fmtDuration(ms: number): string {
  const totalSecs = Math.floor(ms / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

/* -------------------------------------------------------------------------- */
/*                               Notifications                                */
/* -------------------------------------------------------------------------- */

export function notifyBuyOpened(
  tokenName: string,
  fillPrice: number,
  sizeSol: number,
  balanceUsd: number,
  mcap?: number,
  dex?: string,
): void {
  const lines = [
    `🟢 **Position Opened**`,
    `━━━━━━━━━━━━━━━━━━━`,
    `🔖 Token: \`${tokenName}\``,
    `💵 Entry: \`${fmtPrice(fillPrice)}\``,
    `💰 Size: \`${sizeSol} SOL\``,
    `💳 Balance: \`$${balanceUsd.toFixed(2)}\``,
  ];

  if (mcap) lines.push(`📊 MCap: \`${fmtMcap(mcap)}\``);
  if (dex) lines.push(`🏛 Dex: \`${dex}\``);

  sendTelegram(lines.join("\n"));
}

export function notifyTradeClosed(
  tokenName: string,
  pnl: number,
  entryPrice: number,
  exitPrice: number,
  sizeSol: number,
  balanceUsd: number,
  reason: string,
  durationMs: number,
): void {
  const label = pnl >= 0 ? "🟢" : "🔴";

  const lines = [
    `${label} **Trade Closed**`,
    `━━━━━━━━━━━━━━━━━━━`,
    `🔖 Token: \`${tokenName}\``,
    `📈 PnL: **${fmtPct(pnl)}**`,
    `💵 Entry: \`${fmtPrice(entryPrice)}\``,
    `💵 Exit: \`${fmtPrice(exitPrice)}\``,
    `💰 Size: \`${sizeSol} SOL\``,
    `💳 Balance: \`$${balanceUsd.toFixed(2)}\``,
    `📋 Reason: \`${reason}\``,
    `⏱ Duration: \`${fmtDuration(durationMs)}\``,
    `━━━━━━━━━━━━━━━━━━━`,
  ];

  sendTelegram(lines.join("\n"));
}

export function notifyExitTask(
  label: string,
  tokenName: string,
  isSuccess: boolean,
  priceUsd?: number,
  errorMessage?: string,
  txHash?: string,
): void {
  const emoji = isSuccess ? "🟢" : "🔴";

  const lines = [
    `${emoji} **${label} ${isSuccess ? "Success" : "Failed"}**`,
    `━━━━━━━━━━━━━━━━━━━`,
    `🔖 Token: \`${tokenName}\``,
  ];

  if (priceUsd) lines.push(`💵 Price: \`$${priceUsd}\``);
  if (!isSuccess && errorMessage) lines.push(`❌ Error: \`${errorMessage}\``);
  if (isSuccess && txHash) lines.push(`🔗 Tx: \`${txHash.slice(0, 16)}…\``);

  sendTelegram(lines.join("\n"));
}

export function sendTradeReport(
  total: number,
  winRate: number,
  avgWin: number,
  avgLoss: number,
  profitFactor: number,
  expectancy: number,
  medianDurationMs: number,
  best: { tokenName: string; pnl: number },
  worst: { tokenName: string; pnl: number },
  exitTypes: Record<string, number>,
  avgMcap?: number,
): void {
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

  if (avgMcap && avgMcap > 0) {
    lines.push(`Avg MCap: \`${fmtMcap(avgMcap)}\``);
  }

  lines.push(`━━━━━━━━━━━━━━━━━━━`);

  sendTelegram(lines.join("\n"));
}
