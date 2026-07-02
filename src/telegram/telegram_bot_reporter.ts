/**
 * telegram/telegram_bot_reporter.ts
 *
 * RxJS-driven Telegram reporter via grammY.
 *
 * Messages are written in clean standard Markdown and converted to
 * Telegram MarkdownV2 via the `telegram-markdown-v2` library — no
 * manual character escaping needed.
 *
 * Subscribes to position lifecycle events and account snapshots,
 * sending real-time alerts and periodic performance reports to
 * a configured Telegram chat.
 */

import { Bot } from "grammy";
import { Subscription, timer } from "rxjs";
import { tap } from "rxjs/operators";
import { convert } from "telegram-markdown-v2";
import { CONFIG } from "../config";
import { positionEvent$, positionClosed$ } from "../simulator/position_manager";
import type { PositionEvent } from "../simulator/position_manager";
import { latestAccount } from "../simulator/account";
import { generateReport } from "../analytics/reports";
import type { PerformanceReport } from "../analytics/reports";

/* ------------------------------------------------------------------ */
/*  Bot initialisation                                                 */
/* ------------------------------------------------------------------ */

const bot = new Bot(CONFIG.telegramBotToken!);
const CHAT_ID = CONFIG.telegramChatId!;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function fmtPnL(value: number, suffix = ""): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}${suffix}`;
}

function fmtDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1_000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function closeIcon(reason: string): string {
  if (reason === "take_profit") return "\u{1F7E2}";     // 🟢
  if (reason === "stop_loss") return "\u{1F534}";        // 🔴
  if (reason === "trailing_stop") return "\u{1F536}";    // 🔶
  return "\u{26A0}\uFE0F";                                // ⚠️
}

function reasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    take_profit: "Take Profit",
    stop_loss: "Stop Loss",
    trailing_stop: "Trailing Stop",
    expired: "TTL Expired",
    manual: "Manual",
  };
  return labels[reason] ?? reason;
}

/* ------------------------------------------------------------------ */
/*  Message builders (standard Markdown — convert() handles escaping)  */
/* ------------------------------------------------------------------ */

function openedMessage(ev: PositionEvent): string {
  const p = ev.position;
  return convert(
    [
      `🟢 **Position Opened**`,
      "",
      `Token: \`${p.tokenName}\``,
      `Size: **${p.sizeSol.toFixed(2)} SOL**`,
      `Pair: \`${p.pair.slice(0, 12)}...\``,
      `Time: \`${new Date(p.openedAt).toLocaleTimeString()}\``,
    ].join("\n"),
  );
}

function closedMessage(ev: PositionEvent): string {
  const p = ev.position;
  const profit = p.currentProfitPercent;
  const profitUsd = p.currentProfitUsd;
  const isProfit = profit >= 0;
  const reason = p.closeReason ?? "?";

  const icon = isProfit ? "✅" : "❌";
  const headerIcon = isProfit ? "🟢" : "🔴";
  const pnlLine = isProfit
    ? `PnL: **+${profit.toFixed(2)}%** ($+${profitUsd.toFixed(2)})`
    : `PnL: **${profit.toFixed(2)}%** ($${profitUsd.toFixed(2)})`;

  const duration = fmtDuration(p.lastUpdateAt - p.openedAt);

  return convert(
    [
      `${headerIcon} **Position Closed** ${icon}`,
      "",
      `Token: \`${p.tokenName}\``,
      pnlLine,
      `Reason: ${closeIcon(reason)} **${reasonLabel(reason)}**`,
      `Duration: \`${duration}\``,
    ].join("\n"),
  );
}

function summaryMessage(): string {
  const report: PerformanceReport = generateReport();
  const winRateIcon = report.winRate >= 50 ? "✅" : "⚠️";
  const pnlIcon = report.totalProfitUsd >= 0 ? "🟢" : "🔴";

  const lines: string[] = [
    "📊 **Performance Report**",
    "",
    `Mode: 🧪 \`Simulate\``,
    "",
    "---",
    "",
  ];

  /* Balance */
  const balLine = balanceLine();
  if (balLine) lines.push(`${balLine}\n`);

  /* Overview */
  lines.push(
    "**Overview**",
    `Open Positions: \`${report.openPositions}\``,
    `Closed Positions: \`${report.closedPositions}\``,
    `Total Positions: \`${report.totalPositions}\``,
    "",
  );

  /* Wins / Losses */
  lines.push(
    `**Results** ${winRateIcon}`,
    `✅ Wins: \`${report.winningTrades}\``,
    `❌ Losses: \`${report.losingTrades}\``,
    `Win Rate: **${report.winRate.toFixed(1)}%**`,
    "",
  );

  /* PnL */
  lines.push(
    `${pnlIcon} **PnL Summary**`,
    `Total PnL: **${fmtPnL(report.totalProfitPct)}%** (${fmtPnL(report.totalProfitUsd, "$")})`,
    `Avg PnL: **${fmtPnL(report.avgProfitPct)}%** (${fmtPnL(report.avgProfitUsd, "$")})`,
    `Best: **${fmtPnL(report.bestTradePct)}%**`,
    `Worst: **${fmtPnL(report.worstTradePct)}%**`,
    "",
  );

  /* Close reasons */
  if (Object.keys(report.reasons).length > 0) {
    lines.push("**Close Reasons**");
    for (const [r, count] of Object.entries(report.reasons)) {
      lines.push(`${closeIcon(r)} **${reasonLabel(r)}**: \`${count}\``);
    }
  }

  return convert(lines.join("\n"));
}

function balanceLine(): string | null {
  if (!latestAccount) return null;

  const bal = latestAccount.balance;
  const change = latestAccount.changeAll;
  const changeIcon = change >= 0 ? "🟢" : "🔴";
  const changeStr = change >= 0
    ? `+${(change * 100).toFixed(2)}`
    : `${(change * 100).toFixed(2)}`;

  return (
    `${changeIcon} **Balance**: \`${bal.toFixed(2)}\` SOL` +
    ` (\`${changeStr}%\`)`
  );
}

/* ------------------------------------------------------------------ */
/*  Send helper                                                        */
/* ------------------------------------------------------------------ */

async function send(text: string): Promise<void> {
  try {
    await bot.api.sendMessage(CHAT_ID, text, {
      parse_mode: "MarkdownV2",
    });
  } catch (err) {
    console.error("[reporter] Failed to send message:", err);
  }
}

/* ------------------------------------------------------------------ */
/*  Subscriptions                                                      */
/* ------------------------------------------------------------------ */

let subs: Subscription[] = [];

export function startReporter(): void {
  if (subs.length > 0) return;

  subs.push(
    positionEvent$
      .pipe(
        tap((ev) => {
          if (ev.type === "opened") send(openedMessage(ev));
        }),
      )
      .subscribe(),
  );

  subs.push(
    positionClosed$
      .pipe(
        tap((ev) => send(closedMessage(ev))),
      )
      .subscribe(),
  );

  const intervalMs = CONFIG.reportIntervalMinutes * 60 * 1_000;

  if (intervalMs > 0) {
    subs.push(
      timer(intervalMs, intervalMs)
        .pipe(
          tap(() => send(summaryMessage())),
        )
        .subscribe(),
    );
  }
}

export function stopReporter(): void {
  for (const s of subs) s.unsubscribe();
  subs = [];
}
