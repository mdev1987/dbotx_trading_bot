import { Bot } from "grammy";
import { Subscription, timer, Subject } from "rxjs";
import { concatMap, map, distinctUntilChanged } from "rxjs/operators";
import { convert } from "telegram-markdown-v2";
import { CONFIG } from "../config";
import {
  positionEvent$,
  positionClosed$,
  openPositions$,
  getReport,
  getBalanceStr,
} from "../shared/trade_bridge";
import type { PerformanceReport } from "../analytics/reports";
import {
  pauseSignals,
  resumeSignals,
  isSignalPaused,
} from "./signal_control";
import { enablePanic } from "../live/panic";

const bot = new Bot(CONFIG.telegramBotToken!);
const CHAT_ID = CONFIG.telegramChatId!;

// --- Pure formatting utilities ---

function formatPnl(value: number): { icon: string; sign: string } {
  return {
    icon: value >= 0 ? "\u{1F7E2}" : "\u{1F534}",
    sign: value >= 0 ? "+" : "",
  };
}

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
  switch (reason) {
    case "take_profit": return "\u{1F7E2}";
    case "stop_loss": return "\u{1F534}";
    case "trailing_stop": return "\u{1F7E1}";
    case "expired": return "\u{23F0}";
    case "pump_message": return "\u{1F680}";
    default: return "\u{26A0}\uFE0F";
  }
}

function reasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    take_profit: "Take Profit",
    stop_loss: "Stop Loss",
    trailing_stop: "Trailing Stop",
    expired: "TTL Expired",
    manual: "Manual",
    pump_message: "Pump Message",
  };
  return labels[reason] ?? reason;
}

function openLabel(count: number): string {
  return `\u{1F4CC} Positions: \`${count} / ${CONFIG.maxPositions}\``;
}

function winsTotalWinrate(report: PerformanceReport): string {
  const wins = report.winningTrades ?? 0;
  const total = report.closedPositions ?? 0;
  const rate = total > 0 ? report.winRate : 0;
  const icon = rate >= 50 ? "\u{1F3C6}" : "\u{26A0}\uFE0F";
  return `${icon} Wins: \`${wins}\` / \`${total}\` (\`${rate.toFixed(1)}%\`)`;
}

// --- Message builders ---

function openedMessage(
  ev: any,
  openCount: number,
  report: PerformanceReport,
): string {
  const p = ev.position;
  const isPaper = ev.detail === "paper";
  const sig = p.signal as { maxPumpX?: number; fromDEX?: string; nVibeSignal?: number; walletBuyCount?: number; totalBuySol?: number };
  const lines: string[] = [
    isPaper ? "\u{1F4DD} **Paper Position Opened**" : "\u{1F7E2} **Position Opened**",
    "",
    `\u{1F512} Token: \`${p.tokenName}\``,
    `\u{1F4B0} Size: **${p.sizeSol.toFixed(2)} SOL**`,
    `\u{23F0} Time: \`${new Date(p.openedAt).toLocaleTimeString()}\``,
  ];
  if (isPaper) {
    lines.push("\u{1F504} Mode: `Paper (no exchange)`");
  }

  if (sig.fromDEX) lines.push(`\u{1F4E1} From: \`${sig.fromDEX}\``);
  if (sig.maxPumpX !== undefined && sig.maxPumpX > 0) {
    lines.push(`\u{1F680} Max Pump: **x${sig.maxPumpX}**`);
  }
  if (sig.nVibeSignal !== undefined) {
    lines.push(`\u{1F4E2} Signal #${sig.nVibeSignal}`);
  }
  if (sig.walletBuyCount && sig.walletBuyCount > 0) {
    lines.push(`\u{1F464} Wallets: **${sig.walletBuyCount}**`);
  }
  if (sig.totalBuySol && sig.totalBuySol > 0) {
    lines.push(`\u{1F4B0} Buy Vol: **${sig.totalBuySol.toFixed(2)} SOL**`);
  }

  lines.push("", getBalanceStr(), openLabel(openCount), winsTotalWinrate(report));

  return convert(lines.join("\n"));
}

function buildPnlLine(
  profit: number,
  profitUsd: number,
  chartIcon: string,
): string {
  if (profit >= 0) {
    return `${chartIcon} PnL: **+${profit.toFixed(2)}%** (\u0024+${profitUsd.toFixed(2)})`;
  }
  return `${chartIcon} PnL: **${profit.toFixed(2)}%** (\u0024${profitUsd.toFixed(2)})`;
}

function buildExitPrice(
  entryPriceUsd: number | null,
  profit: number,
  exitPriceUsd?: number | null,
): string {
  if (entryPriceUsd === null) return "";
  const computed = entryPriceUsd * (1 + profit / 100);
  const exitPrice = computed > 0 ? computed : (exitPriceUsd ?? 0);
  if (exitPrice <= 0) return "";
  return `\u{1F4B4} Exit: \`$${exitPrice.toFixed(8)}\``;
}

function closedMessage(
  ev: any,
  openCount: number,
  report: PerformanceReport,
): string {
  const p = ev.position;
  const profit = p.currentProfitPercent;
  const profitUsd = p.currentProfitUsd;
  const isProfit = profit >= 0;
  const reason = p.closeReason ?? "?";
  const duration = fmtDuration(p.lastUpdateAt - p.openedAt);

  const resultIcon = isProfit ? "\u{2705}" : "\u{274C}";
  const headerIcon = isProfit ? "\u{1F7E2}" : "\u{1F534}";
  const chartIcon = isProfit ? "\u{1F4C8}" : "\u{1F4C9}";

  const lines: string[] = [
    `${headerIcon} **Position Closed** ${resultIcon}`,
    "",
    `\u{1F512} Token: \`${p.tokenName}\``,
  ];

  if (reason === "pump_message" && ev.detail) {
    lines.push(`\u{1F680} ${ev.detail}`);
  }

  lines.push(
    p.entryPriceUsd !== null
      ? `\u{1F4B5} Entry: \`$${p.entryPriceUsd.toFixed(8)}\``
      : "",
    buildExitPrice(p.entryPriceUsd, profit, p.exitPriceUsd),
    buildPnlLine(profit, profitUsd, chartIcon),
    `\u{1F517} Reason: ${closeIcon(reason)} **${reasonLabel(reason)}**`,
    `\u{23F1}\uFE0F Duration: \`${duration}\``,
    "",
    getBalanceStr(),
    openLabel(openCount),
    winsTotalWinrate(report),
  );

  return convert(lines.filter(Boolean).join("\n"));
}

function buildCloseReasons(report: PerformanceReport): string[] {
  const lines: string[] = [];
  if (Object.keys(report.reasons).length > 0) {
    lines.push("**Close Reasons**");
    for (const [r, count] of Object.entries(report.reasons)) {
      lines.push(`${closeIcon(r)} **${reasonLabel(r)}**: \`${count}\``);
    }
  }
  return lines;
}

function summaryMessage(
  openCount: number,
  report: PerformanceReport,
): string {
  const winRateIcon = report.winRate >= 50 ? "\u{1F3C6}" : "\u{26A0}\uFE0F";
  const pnl = formatPnl(report.totalProfitUsd);

  const lines: string[] = [
    "\u{1F4CA} **Performance Report**",
    "",
    "Mode: \u{1F9EA} \`Simulate\`",
    "",
    "---",
    "",
  ];

  const bal = getBalanceStr();
  if (bal) lines.push(`${bal}\n`);

  lines.push(
    "**Overview**",
    openLabel(openCount),
    `\u{2705} Closed: \`${report.closedPositions}\``,
    `\u{1F4CB} Total: \`${report.totalPositions}\``,
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
    `${pnl.icon} **PnL Summary**`,
    `\u{1F4B0} Total PnL: **${fmtPnL(report.totalProfitPct)}%** (${fmtPnL(report.totalProfitUsd, "$")})`,
    `\u{1F4C8} Avg PnL: **${fmtPnL(report.avgProfitPct)}%** (${fmtPnL(report.avgProfitUsd, "$")})`,
    `\u{1F3C6} Best: **${fmtPnL(report.bestTradePct)}%**`,
    `\u{1F4A9} Worst: **${fmtPnL(report.worstTradePct)}%**`,
    "",
  );

  lines.push(...buildCloseReasons(report));

  return convert(lines.join("\n"));
}

// --- Reporter service ---

class TelegramReporter {
  private send$ = new Subject<string>();
  private subs: Subscription[] = [];
  openCount = 0;

  constructor() {
    this.send$
      .pipe(concatMap((text) => this.sendWithRetry(text)))
      .subscribe();

    openPositions$.subscribe((positions: any[]) => {
      this.openCount = positions.length;
    });
  }

  start(): void {
    if (this.subs.length > 0) return;

    this.subs.push(
      positionEvent$
        .pipe(
          map((ev) => {
            if (ev.type !== "opened") return null;
            try {
              return openedMessage(ev, this.openCount, getReport());
            } catch (err) {
              console.error("[reporter] Failed to build opened message:", err);
              return null;
            }
          }),
        )
        .subscribe((msg) => {
          if (msg) this.send$.next(msg);
        }),
    );

    this.subs.push(
      positionClosed$
        .pipe(
          map((ev) => {
            try {
              return closedMessage(ev, this.openCount, getReport());
            } catch (err) {
              console.error("[reporter] Failed to build closed message:", err);
              return null;
            }
          }),
        )
        .subscribe((msg) => {
          if (msg) this.send$.next(msg);
        }),
    );

    const intervalMs = CONFIG.reportIntervalMinutes * 60 * 1_000;
    if (intervalMs > 0) {
      this.subs.push(
        timer(intervalMs, intervalMs)
          .pipe(
            map(() => {
              try {
                return getReport();
              } catch (err) {
                console.error("[reporter] Failed to generate report:", err);
                return null;
              }
            }),
            distinctUntilChanged(
              (prev, curr) => {
                if (!prev || !curr) return false;
                return JSON.stringify(prev) === JSON.stringify(curr);
              },
            ),
            map((report) => {
              if (!report) return null;
              return summaryMessage(this.openCount, report);
            }),
          )
          .subscribe((msg) => {
            if (msg) this.send$.next(msg);
          }),
      );
    }
  }

  stop(): void {
    for (const s of this.subs) s.unsubscribe();
    this.subs = [];
  }

  sendMessage(text: string): void {
    this.send$.next(text);
  }

  private async sendWithRetry(text: string, retries = 3): Promise<void> {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        await bot.api.sendMessage(CHAT_ID, text, {
          parse_mode: "MarkdownV2",
        });
        return;
      } catch (err: unknown) {
        if (attempt === retries - 1) {
          console.error("[reporter] Failed to send message after all retries:", err);
        } else {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
    }
  }
}

const reporter = new TelegramReporter();

// ── Bot commands ──────────────────────────────────────────────────────────
bot.command("start", async (ctx) => {
  resumeSignals();
  await ctx.reply("\u25B6\uFE0F Signal processing resumed");
});

bot.command("pause", async (ctx) => {
  pauseSignals();
  await ctx.reply(
    "\u23F8\uFE0F Signal processing paused.\n" +
      "Existing positions continue with TP/SL/trailing.",
  );
});

bot.command("status", async (ctx) => {
  const paused = isSignalPaused();
  const lines = [
    paused
      ? "\u23F8\uFE0F Signal: **Paused**"
      : "\u25B6\uFE0F Signal: **Active**",
    `\u{1F4CC} Open positions: ${reporter.openCount}`,
  ];
  await ctx.reply(lines.join("\n"));
});

bot.command("panic", async (ctx) => {
  await ctx.reply(
    "\u{1F6A8} **PANIC MODE**\n" +
      "Enabling panic. No new positions will be opened.\n" +
      "A `STOP_TRADING_LIVE` file has been created.",
  );
  pauseSignals();
  enablePanic();
});

bot.start({
  onStart: () => console.log("[reporter] Bot command polling started"),
}).catch((err) => console.error("[reporter] Bot polling failed:", err));

export function startReporter(): void {
  reporter.start();
}

export function stopReporter(): void {
  reporter.stop();
  bot.stop();
}

export function sendMessage(text: string): void {
  reporter.sendMessage(text);
}
