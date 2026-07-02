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

const bot = new Bot(CONFIG.telegramBotToken!);
const CHAT_ID = CONFIG.telegramChatId!;

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
  if (reason === "take_profit") return "\u{1F7E2}";
  if (reason === "stop_loss") return "\u{1F534}";
  if (reason === "trailing_stop") return "\u{1F7E1}";
  if (reason === "expired") return "\u{23F0}";
  return "\u{26A0}\uFE0F";
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

function balanceStr(): string {
  if (!latestAccount) return "";
  const bal = latestAccount.balance;
  const change = latestAccount.changeAll;
  const icon = change >= 0 ? "\u{1F7E2}" : "\u{1F534}";
  const sign = change >= 0 ? "+" : "";
  return `${icon} \u{1F4B0} Balance: \`${bal.toFixed(2)}\` SOL (\`${sign}${(change * 100).toFixed(2)}%\`)`;
}

function openPositionsCount(): number {
  if (!latestAccount) return 0;
  return latestAccount.holdTokens;
}

function winsTotalWinrate(): string {
  const r = generateReport();
  const winIcon = r.winRate >= 50 ? "\u{1F3C6}" : "\u{26A0}\uFE0F";
  return `${winIcon} Wins: \`${r.winningTrades}\` / \`${r.closedPositions}\` (\`${r.winRate.toFixed(1)}%\`)`;
}

function openedMessage(ev: PositionEvent): string {
  const p = ev.position;
  const total = generateReport();
  const open = openPositionsCount();

  return convert(
    [
      "\u{1F7E2} **Position Opened**",
      "",
      `Token: \`${p.tokenName}\``,
      `Size: **${p.sizeSol.toFixed(2)} SOL**`,
      `Pair: \`${p.pair.slice(0, 12)}...\``,
      `Time: \`${new Date(p.openedAt).toLocaleTimeString()}\``,
      "",
      balanceStr(),
      `\u{1F4CA} Positions: **${open}** open / **${total.totalPositions}** total`,
      winsTotalWinrate(),
    ].join("\n"),
  );
}

function closedMessage(ev: PositionEvent): string {
  const p = ev.position;
  const profit = p.currentProfitPercent;
  const profitUsd = p.currentProfitUsd;
  const isProfit = profit >= 0;
  const reason = p.closeReason ?? "?";

  const resultIcon = isProfit ? "\u{2705}" : "\u{274C}";
  const headerIcon = isProfit ? "\u{1F7E2}" : "\u{1F534}";
  const chartIcon = isProfit ? "\u{1F4C8}" : "\u{1F4C9}";

  const pnlLine = isProfit
    ? `${chartIcon} PnL: **+${profit.toFixed(2)}%** (\u0024+${profitUsd.toFixed(2)})`
    : `${chartIcon} PnL: **${profit.toFixed(2)}%** (\u0024${profitUsd.toFixed(2)})`;

  const duration = fmtDuration(p.lastUpdateAt - p.openedAt);
  const total = generateReport();
  const open = openPositionsCount();

  let exitPriceStr = "";
  if (p.entryPriceUsd !== null) {
    const exitPrice = p.entryPriceUsd * (1 + profit / 100);
    exitPriceStr = `\u{1F4B4} Exit: \`$${exitPrice.toFixed(8)}\``;
  }

  return convert(
    [
      `${headerIcon} **Position Closed** ${resultIcon}`,
      "",
      `Token: \`${p.tokenName}\``,
      p.entryPriceUsd !== null
        ? `\u{1F4B5} Entry: \`$${p.entryPriceUsd.toFixed(8)}\``
        : "",
      exitPriceStr,
      pnlLine,
      `\u{1F517} Reason: ${closeIcon(reason)} **${reasonLabel(reason)}**`,
      `\u{23F1}\uFE0F Duration: \`${duration}\``,
      "",
      balanceStr(),
      `\u{1F4CA} Positions: **${open}** open / **${total.totalPositions}** total`,
      winsTotalWinrate(),
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

function summaryMessage(): string {
  const report: PerformanceReport = generateReport();
  const winRateIcon = report.winRate >= 50 ? "\u{1F3C6}" : "\u{26A0}\uFE0F";
  const pnlIcon = report.totalProfitUsd >= 0 ? "\u{1F7E2}" : "\u{1F534}";

  const lines: string[] = [
    "\u{1F4CA} **Performance Report**",
    "",
    `Mode: \u{1F9EA} \`Simulate\``,
    "",
    "---",
    "",
  ];

  const bal = balanceStr();
  if (bal) lines.push(`${bal}\n`);

  lines.push(
    "**Overview**",
    `\u{1F4CC} Open Positions: \`${report.openPositions}\``,
    `\u{2705} Closed Positions: \`${report.closedPositions}\``,
    `\u{1F4CB} Total Positions: \`${report.totalPositions}\``,
    "",
  );

  lines.push(
    `**Results** ${winRateIcon}`,
    `\u{2705} Wins: \`${report.winningTrades}\``,
    `\u{274C} Losses: \`${report.losingTrades}\``,
    `\u{1F3AF} Win Rate: **${report.winRate.toFixed(1)}%**`,
    "",
  );

  lines.push(
    `${pnlIcon} **PnL Summary**`,
    `\u{1F4B0} Total PnL: **${fmtPnL(report.totalProfitPct)}%** (${fmtPnL(report.totalProfitUsd, "$")})`,
    `\u{1F4C8} Avg PnL: **${fmtPnL(report.avgProfitPct)}%** (${fmtPnL(report.avgProfitUsd, "$")})`,
    `\u{1F3C6} Best: **${fmtPnL(report.bestTradePct)}%**`,
    `\u{1F4A9} Worst: **${fmtPnL(report.worstTradePct)}%**`,
    "",
  );

  if (Object.keys(report.reasons).length > 0) {
    lines.push("**Close Reasons**");
    for (const [r, count] of Object.entries(report.reasons)) {
      lines.push(`${closeIcon(r)} **${reasonLabel(r)}**: \`${count}\``);
    }
  }

  return convert(lines.join("\n"));
}

async function send(text: string): Promise<void> {
  try {
    await bot.api.sendMessage(CHAT_ID, text, {
      parse_mode: "MarkdownV2",
    });
  } catch (err) {
    console.error("[reporter] Failed to send message:", err);
  }
}

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
