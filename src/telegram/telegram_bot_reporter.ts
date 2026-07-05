import { Bot } from "grammy";
import { Subscription, timer, Subject } from "rxjs";
import { concatMap, map, distinctUntilChanged } from "rxjs/operators";
import { convert } from "telegram-markdown-v2";
import { CONFIG } from "../config";
import {
  positionEvent$,
  positionClosed$,
  openPositions$,
} from "../simulator/position_manager";
import type { PositionEvent } from "../simulator/position_manager";
import { simulatorAccount$, latestAccount } from "../simulator/account";
import type { SimulatorAccount } from "../simulator/account";
import { generateReport } from "../analytics/reports";
import type { PerformanceReport } from "../analytics/reports";

const bot = new Bot(CONFIG.telegramBotToken!);
const CHAT_ID = CONFIG.telegramChatId!;

// --- Pure formatting utilities ---

/**
 * Determine the emoji icon and sign prefix for a PnL value.
 *
 * @param value - Profit/loss value (positive = green circle, negative = red circle).
 * @returns Icon emoji and sign string for display.
 */
function formatPnl(value: number): { icon: string; sign: string } {
  return {
    icon: value >= 0 ? "\u{1F7E2}" : "\u{1F534}",
    sign: value >= 0 ? "+" : "",
  };
}

/**
 * Format a PnL value as a signed string with an optional suffix.
 *
 * @param value - PnL value to format.
 * @param suffix - Optional trailing character (e.g. "$", "%").
 * @returns Signed, fixed-precision string (e.g. "+12.34$").
 */
function fmtPnL(value: number, suffix = ""): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}${suffix}`;
}

/**
 * Format a duration in milliseconds to a human-readable string.
 *
 * @param ms - Duration in milliseconds.
 * @returns Formatted string (e.g. "2m 30s" or "15s").
 */
function fmtDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1_000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/**
 * Return a colored emoji icon for a given close reason.
 *
 * @param reason - Close reason key (take_profit, stop_loss, etc.).
 * @returns Emoji icon representing the outcome of the reason.
 */
function closeIcon(reason: string): string {
  switch (reason) {
    case "take_profit": return "\u{1F7E2}";       // Green: profitable TP
    case "stop_loss": return "\u{1F534}";          // Red: stopped out
    case "trailing_stop": return "\u{1F7E1}";      // Yellow: trailing stop triggered
    case "expired": return "\u{23F0}";             // Clock: TTL expired
    case "pump_message": return "\u{1F680}";       // Rocket: pump message closed
    default: return "\u{26A0}\uFE0F";              // Warning: unknown reason
  }
}

/**
 * Return a human-readable label for a close reason key.
 *
 * @param reason - Close reason key.
 * @returns Human-readable label (e.g. "Take Profit") or the raw key if unknown.
 */
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

/**
 * Format the account balance line with a change indicator and emoji.
 *
 * @param account - Current simulator account state (nullable — returns empty if null).
 * @returns Formatted balance string (e.g. "🟢 💰 Balance: `$123.45` (`+5.00%`)") or "".
 */
function balanceStr(account: SimulatorAccount | null): string {
  if (!account) return "";
  const change = account.changeAll;
  const pnl = formatPnl(change);
  return `${pnl.icon} \u{1F4B0} Balance: \`$${account.balance.toFixed(2)}\` (\`${pnl.sign}${(change * 100).toFixed(2)}%\`)`;
}

/**
 * Format the open position count label, adapting the display to the channel mode.
 *
 * @param count - Number of currently open positions.
 * @returns Formatted label showing position count and limit info.
 */
function openLabel(count: number): string {
  switch (CONFIG.telegramChannelUserName) {
    case "avesignalmonitor":
      return `\u{1F4CC} Positions: \`${count}\` (no limit)`;
    case "avesolantokenscanner":
      return `\u{1F4CC} Positions: \`${count} / ${CONFIG.maxPositions}\``;
    default:
      return `\u{1F4CC} Positions: \`${count}\` (no limit)`;
  }
}

/**
 * Format the wins / total / win-rate line for a performance report.
 *
 * @param report - Performance report data.
 * @returns Formatted win-rate string with a trophy (≥50%) or warning (<50%) icon.
 */
function winsTotalWinrate(report: PerformanceReport): string {
  const wins = report.winningTrades ?? 0;
  const total = report.closedPositions ?? 0;
  const rate = total > 0 ? report.winRate : 0;
  const icon = rate >= 50 ? "\u{1F3C6}" : "\u{26A0}\uFE0F";
  return `${icon} Wins: \`${wins}\` / \`${total}\` (\`${rate.toFixed(1)}%\`)`;
}

// --- Message builders ---

/**
 * Build the Telegram message for a newly opened position.
 *
 * @param ev - The position opened event from the position manager.
 * @param account - Current account state (nullable).
 * @param openCount - Number of positions currently open.
 * @param report - Aggregated performance report for win-rate context.
 * @returns Telegram MarkdownV2 formatted message string.
 */
function openedMessage(
  ev: PositionEvent,
  account: SimulatorAccount | null,
  openCount: number,
  report: PerformanceReport,
): string {
  const p = ev.position;
  const sig = p.signal as { maxPumpX?: number; fromDEX?: string; nVibeSignal?: number; walletBuyCount?: number; totalBuySol?: number };
  const lines: string[] = [
    "\u{1F7E2} **Position Opened**",
    "",
    `\u{1F512} Token: \`${p.tokenName}\``,
    `\u{1F4B0} Size: **${p.sizeSol.toFixed(2)} SOL**`,
    `\u{23F0} Time: \`${new Date(p.openedAt).toLocaleTimeString()}\``,
  ];

  // Signal metadata
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

  lines.push("", balanceStr(account), openLabel(openCount), winsTotalWinrate(report));

  return convert(lines.join("\n"));
}

/**
 * Build a single PnL display line with percentage and USD value.
 *
 * Handles the "+" prefix for positive values automatically.
 *
 * @param profit - Profit percentage.
 * @param profitUsd - Profit in USD.
 * @param chartIcon - Emoji icon for direction (chart up or chart down).
 * @returns Formatted PnL line string.
 */
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

/**
 * Calculate and format the exit price based on entry price and PnL percentage.
 *
 * @param entryPriceUsd - Entry price in USD (nullable — returns empty if null).
 * @param profit - Profit percentage used to derive the exit price.
 * @returns Formatted exit price line or empty string if entry is unknown.
 */
function buildExitPrice(
  entryPriceUsd: number | null,
  profit: number,
  exitPriceUsd?: number | null,
): string {
  // Prefer the actual execution price when available (populated by Bug 2 fix).
  if (exitPriceUsd != null) {
    return `\u{1F4B4} Exit: \`$${exitPriceUsd.toFixed(8)}\``;
  }
  if (entryPriceUsd === null) return "";
  // Fallback: derive exit price from entry and PnL percentage.
  const exitPrice = entryPriceUsd * (1 + profit / 100);
  return `\u{1F4B4} Exit: \`$${exitPrice.toFixed(8)}\``;
}

/**
 * Build the Telegram message for a closed position with full details.
 *
 * @param ev - The position closed event from the position manager.
 * @param account - Current account state (nullable).
 * @param openCount - Number of positions currently open.
 * @param report - Aggregated performance report for win-rate context.
 * @returns Telegram MarkdownV2 formatted message string.
 */
function closedMessage(
  ev: PositionEvent,
  account: SimulatorAccount | null,
  openCount: number,
  report: PerformanceReport,
): string {
  const p = ev.position;
  const profit = p.currentProfitPercent;
  const profitUsd = p.currentProfitUsd;
  const isProfit = profit >= 0;
  const reason = p.closeReason ?? "?";
  const duration = fmtDuration(p.lastUpdateAt - p.openedAt);

  // Choose icons based on profit/loss direction
  const resultIcon = isProfit ? "\u{2705}" : "\u{274C}";     // Green check / Red X
  const headerIcon = isProfit ? "\u{1F7E2}" : "\u{1F534}";   // Green / Red circle
  const chartIcon = isProfit ? "\u{1F4C8}" : "\u{1F4C9}";    // Chart up / Chart down

  const lines: string[] = [
    `${headerIcon} **Position Closed** ${resultIcon}`,
    "",
    `\u{1F512} Token: \`${p.tokenName}\``,
  ];

  // Show pump details when closed by pump message
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
    balanceStr(account),
    openLabel(openCount),
    winsTotalWinrate(report),
  );

  return convert(lines.filter(Boolean).join("\n"));
}

/**
 * Build the close-reasons breakdown section for a summary report.
 *
 * @param report - Performance report containing the reasons map.
 * @returns Array of lines for the close reasons section (empty array if none).
 */
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

/**
 * Build the periodic performance summary message with full report breakdown.
 *
 * @param account - Current account state (nullable).
 * @param openCount - Number of positions currently open.
 * @param report - Aggregated performance report.
 * @returns Telegram MarkdownV2 formatted summary message.
 */
function summaryMessage(
  account: SimulatorAccount | null,
  openCount: number,
  report: PerformanceReport,
): string {
  const winRateIcon = report.winRate >= 50 ? "\u{1F3C6}" : "\u{26A0}\uFE0F";
  const pnl = formatPnl(report.totalProfitUsd);

  // Header section with title and simulation mode badge
  const lines: string[] = [
    "\u{1F4CA} **Performance Report**",   // Chart icon with bold title
    "",                                    // Blank line
    "Mode: \u{1F9EA} \`Simulate\`",        // Simulation mode badge
    "",                                    // Blank line
    "---",                                 // Horizontal separator
    "",                                    // Blank line
  ];

  // Account balance line (only if account is available)
  const bal = balanceStr(account);
  if (bal) lines.push(`${bal}\n`);

  // Overview: open count, closed count, total positions
  lines.push(
    "**Overview**",
    openLabel(openCount),
    `\u{2705} Closed: \`${report.closedPositions}\``,
    `\u{1F4CB} Total: \`${report.totalPositions}\``,
    "",
  );

  // Results: wins, losses, win rate with trophy/warning icon
  lines.push(
    `**Results** ${winRateIcon}`,
    `\u{2705} Wins: \`${report.winningTrades}\``,
    `\u{274C} Losses: \`${report.losingTrades}\``,
    `\u{1F3AF} Win Rate: **${report.winRate.toFixed(1)}%**`,
    "",
  );

  // PnL summary: totals, averages, best/worst trades
  lines.push(
    `${pnl.icon} **PnL Summary**`,
    `\u{1F4B0} Total PnL: **${fmtPnL(report.totalProfitPct)}%** (${fmtPnL(report.totalProfitUsd, "$")})`,
    `\u{1F4C8} Avg PnL: **${fmtPnL(report.avgProfitPct)}%** (${fmtPnL(report.avgProfitUsd, "$")})`,
    `\u{1F3C6} Best: **${fmtPnL(report.bestTradePct)}%**`,
    `\u{1F4A9} Worst: **${fmtPnL(report.worstTradePct)}%**`,
    "",
  );

  // Close reason breakdown (only shown if there are reasons)
  lines.push(...buildCloseReasons(report));

  return convert(lines.join("\n"));
}

// --- Reporter service ---

/**
 * Manages Telegram message reporting for position events and periodic summaries.
 *
 * Subscribes to position event streams and forwards formatted messages
 * through a serialized send pipeline with automatic retry on failure.
 */
class TelegramReporter {
  /** Subject that serializes outbound messages (processed one-at-a-time via concatMap). */
  private send$ = new Subject<string>();
  /** Holds active RxJS subscriptions for cleanup on stop(). */
  private subs: Subscription[] = [];
  /** Cached snapshot of the latest simulator account state. */
  private account: SimulatorAccount | null = null;
  /** Cached count of currently open positions. */
  private openCount = 0;

  constructor() {
    // Serialize outbound messages — process one at a time in FIFO order
    this.send$
      .pipe(concatMap((text) => this.sendWithRetry(text)))
      .subscribe();

    // Keep an up-to-date snapshot of the account state
    simulatorAccount$.subscribe((a) => {
      this.account = a;
    });

    // Keep an up-to-date count of open positions
    openPositions$.subscribe((positions) => {
      this.openCount = positions.length;
    });
  }

  /**
   * Activate all reporting subscriptions.
   *
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  start(): void {
    // Guard: prevent duplicate subscriptions
    if (this.subs.length > 0) return;

    // Subscribe 1: position-opened events → build and enqueue an "opened" message
    // Uses the synchronous latestAccount snapshot (already refreshed in
    // openPosition before the event was emitted) so the balance displayed
    // is always correct (post-buy), never stale.
    this.subs.push(
      positionEvent$
        .pipe(
          map((ev) => {
            if (ev.type !== "opened") return null;
            return openedMessage(ev, latestAccount, this.openCount, generateReport());
          }),
        )
        .subscribe((msg) => {
          if (msg) this.send$.next(msg);
        }),
    );

    // Subscribe 2: position-closed events → build and enqueue a "closed" message
    this.subs.push(
      positionClosed$
        .pipe(
          map((ev) => {
            const report = generateReport();
            return closedMessage(ev, latestAccount, this.openCount, report);
          }),
        )
        .subscribe((msg) => this.send$.next(msg)),
    );

    // Subscribe 3: periodic summary report (if interval is configured > 0)
    const intervalMs = CONFIG.reportIntervalMinutes * 60 * 1_000;
    if (intervalMs > 0) {
      this.subs.push(
        timer(intervalMs, intervalMs)
          .pipe(
            map(() => generateReport()),
            // Only send if the report actually changed since last tick
            distinctUntilChanged(
              (prev, curr) => JSON.stringify(prev) === JSON.stringify(curr),
            ),
            map((report) => summaryMessage(this.account, this.openCount, report)),
          )
          .subscribe((msg) => this.send$.next(msg)),
      );
    }
  }

  /**
   * Tear down all reporting subscriptions.
   */
  stop(): void {
    for (const s of this.subs) s.unsubscribe();
    this.subs = [];
  }

  /**
   * Enqueue a custom message for delivery through the serialized pipeline.
   *
   * @param text - Message text to send (MarkdownV2 formatted).
   */
  sendMessage(text: string): void {
    this.send$.next(text);
  }

  /**
   * Send a message with linear backoff retry on failure.
   *
   * Does not rethrow — errors are logged and swallowed after exhausting retries
   * so a single failed message does not block the serialized pipeline.
   *
   * @param text - The message text to send (MarkdownV2 formatted).
   * @param retries - Maximum number of send attempts (default 3).
   * @returns Resolves when sent successfully, or after all retries are exhausted.
   */
  private async sendWithRetry(text: string, retries = 3): Promise<void> {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        // Attempt to send the message via Telegram Bot API
        await bot.api.sendMessage(CHAT_ID, text, {
          parse_mode: "MarkdownV2",
        });
        return;  // Success — exit the retry loop immediately
      } catch (err: unknown) {
        if (attempt === retries - 1) {
          // Last attempt failed — log the error without rethrowing
          console.error("[reporter] Failed to send message after all retries:", err);
        } else {
          // Linear backoff: wait 1s, 2s, 3s... before next attempt
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
    }
  }
}

const reporter = new TelegramReporter();

export function startReporter(): void {
  reporter.start();
}

export function stopReporter(): void {
  reporter.stop();
}

export function sendMessage(text: string): void {
  reporter.sendMessage(text);
}
