import { Bot } from "grammy";
import { convert } from "telegram-markdown-v2";

import { Observable, Subject, Subscription, timer } from "rxjs";
import { concatMap, distinctUntilChanged, filter, map } from "rxjs/operators";

import { CONFIG } from "../config";

import type { PerformanceReport } from "../data_stream/types";

const bot = new Bot(CONFIG.telegramBotToken!);
const CHAT_ID = CONFIG.telegramChatId!;

const SEPARATOR = "━━━━━━━━━━━━━━━━━━━";

function fmtSigned(value: number, suffix = ""): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}${suffix}`;
}

function fmtUsd(value: number): string {
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.001) return `$${value.toFixed(6)}`;
  return `$${value.toFixed(10)}`;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function fmtDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const hrs = Math.floor(mins / 60);
  if (hrs > 0) return `${hrs}h ${mins % 60}m ${secs % 60}s`;
  if (mins > 0) return `${mins}m ${secs % 60}s`;
  return `${secs}s`;
}

function closeIcon(reason: string): string {
  switch (reason) {
    case "take_profit": return "🟢";
    case "stop_loss": return "🔴";
    case "trailing_stop": return "🟡";
    case "trailing_tp": return "🔵";
    case "expired": return "⏰";
    case "manual": return "👤";
    default: return "⚠️";
  }
}

function closeLabel(reason: string): string {
  const labels: Record<string, string> = {
    take_profit: "Take Profit",
    stop_loss: "Stop Loss",
    trailing_stop: "Trailing Stop",
    trailing_tp: "Trailing TP",
    expired: "TTL Expired",
    manual: "Manual Close",
  };
  return labels[reason] ?? reason;
}

export interface ReporterCallbacks {
  getReport(): PerformanceReport;
  getBalanceStr(): string;
  openPositions$: Observable<any[]>;
  positionEvent$: Observable<any>;
  positionClosed$: Observable<any>;
}

export class TelegramReporter {
  private readonly sendQueue$ = new Subject<string>();
  private readonly subscriptions: Subscription[] = [];
  private callbacks!: ReporterCallbacks;
  public openCount = 0;

  wire(callbacks: ReporterCallbacks): void {
    this.callbacks = callbacks;
  }

  private get isWired(): boolean {
    return this.callbacks !== undefined;
  }

  /** Convert markdown safely, falling back to raw text on error */
  private safeConvert(msg: string): string {
    try {
      return convert(msg);
    } catch (e) {
      console.error("[Reporter] markdown convert error:", e);
      return msg;
    }
  }

  start(): void {
    if (this.subscriptions.length > 0) return;
    if (!this.isWired) {
      throw new Error(
        "TelegramReporter.start() called before wire(). Call reporter.wire(callbacks) first.",
      );
    }

    this.subscriptions.push(
      this.sendQueue$
        .pipe(
          concatMap((msg) => {
            const converted = this.safeConvert(msg);
            return this.sendWithRetry(converted);
          }),
        )
        .subscribe({
          error: (e) => console.error("[Reporter] sendQueue error:", e),
        }),
    );

    this.subscriptions.push(
      this.callbacks.openPositions$.subscribe((positions) => {
        this.openCount = positions.length;
      }),
    );

    this.subscriptions.push(
      this.callbacks.positionEvent$
        .pipe(filter((ev) => ev.type === "opened"))
        .subscribe((ev) => {
          try { this.enqueueMessage(this.buildOpened(ev)); }
          catch (e) { console.error("[Reporter] buildOpened error:", e); }
        }),
    );

    this.subscriptions.push(
      this.callbacks.positionClosed$.subscribe((ev) => {
        try { this.enqueueMessage(this.buildClosed(ev)); }
        catch (e) { console.error("[Reporter] buildClosed error:", e); }
      }),
    );

    const intervalMs = CONFIG.reportIntervalMinutes * 60_000;
    if (intervalMs > 0) {
      this.subscriptions.push(
        timer(intervalMs, intervalMs)
          .pipe(
            map(() => { try { return this.callbacks.getReport(); } catch { return null; } }),
            distinctUntilChanged((a, b) => {
              if (!a || !b) return false;
              return JSON.stringify(a) === JSON.stringify(b);
            }),
            filter((r): r is PerformanceReport => r !== null),
          )
          .subscribe((r) => this.enqueueMessage(this.buildSummary(r))),
      );
    }

    console.log("[Reporter] Started");
  }

  async stop(): Promise<void> {
    // Give the queue a moment to drain before tearing down
    await new Promise((r) => setTimeout(r, 2000));
    for (const sub of this.subscriptions) sub.unsubscribe();
    this.subscriptions.length = 0;
    this.sendQueue$.complete();
    bot.stop();
    console.log("[Reporter] Stopped");
  }

  sendMessage(message: string): void {
    this.enqueueMessage(message);
  }

  private enqueueMessage(message: string): void {
    this.sendQueue$.next(message);
  }

  private async sendWithRetry(message: string, maxRetries = 3): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await bot.api.sendMessage(CHAT_ID, message, { parse_mode: "MarkdownV2" });
        return;
      } catch (error) {
        if (attempt === maxRetries) {
          console.error("[Reporter] Failed to send:", error);
          return;
        }
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
      }
    }
  }

  // ── Message builders ────────────────────────────────────────────────────

  private buildOpened(event: any): string {
    const p = event.position;
    const report = this.callbacks.getReport();
    const mode = CONFIG.liveMode ? "📡 Live" : "🧪 Simulate";

    const lines = [
      `🟢 **Position Opened**`,
      `${SEPARATOR}`,
      `🔖 Token: \`${p.tokenName}\``,
      `💵 Entry: \`${fmtUsd(p.entryPriceUsd)}\``,
      `💰 Size: \`${p.sizeSol.toFixed(2)} SOL\``,
      `🕐 Time: \`${fmtTime(p.openedAt)}\``,
      `${SEPARATOR}`,
      this.callbacks.getBalanceStr(),
      `📌 Positions: \`${report.openPositions} / ${CONFIG.maxPositions}\``,
      `📶 Mode: \`${mode}\``,
    ];

    return lines.join("\n");
  }

  private buildClosed(event: any): string {
    const p = event.position;
    const report = this.callbacks.getReport();
    const mode = CONFIG.liveMode ? "📡 Live" : "🧪 Simulate";
    const reason = p.closeReason ?? "unknown";
    const pnlPct = p.currentProfitPct ?? 0;
    const profitable = pnlPct >= 0;
    const durationMs = (p.closedAt ?? Date.now()) - (p.openedAt ?? Date.now());

    const lines = [
      `${profitable ? "🟢" : "🔴"} **Position Closed** ${profitable ? "✅" : "❌"}`,
      `${SEPARATOR}`,
      `🔖 Token: \`${p.tokenName}\``,
      `💵 Entry: \`${fmtUsd(p.entryPriceUsd)}\``,
    ];

    if (p.closePriceUsd != null) {
      lines.push(`💵 Exit: \`${fmtUsd(p.closePriceUsd)}\``);
    }

    lines.push(
      `📈 PnL: **${fmtSigned(pnlPct * 100)}%**`,
      `⏱ Duration: \`${fmtDuration(durationMs)}\``,
      `🔗 Reason: ${closeIcon(reason)} **${closeLabel(reason)}**`,
      `${SEPARATOR}`,
      this.callbacks.getBalanceStr(),
      `📌 Positions: \`${report.openPositions} / ${CONFIG.maxPositions}\``,
      `📶 Mode: \`${mode}\``,
    );

    return lines.join("\n");
  }

  private buildSummary(report: PerformanceReport): string {
    const mode = CONFIG.liveMode ? "📡 Live" : "🧪 Simulate";

    const lines = [
      `📊 **Performance Report**`,
      `${SEPARATOR}`,
      `📶 Mode: \`${mode}\``,
      `${SEPARATOR}`,
      this.callbacks.getBalanceStr(),
      `${SEPARATOR}`,
      `📌 Open Positions: \`${report.openPositions} / ${CONFIG.maxPositions}\``,
      `✅ Closed Positions: \`${report.closedPositions}\``,
      `📋 Total Positions: \`${report.totalPositions}\``,
      `${SEPARATOR}`,
      `${report.winRate >= 50 ? "🏆" : "⚠️"} **Trading Results**`,
      `✅ Wins: \`${report.winningTrades}\``,
      `❌ Losses: \`${report.losingTrades}\``,
      `🎯 Win Rate: **${report.winRate.toFixed(1)}%**`,
      `${SEPARATOR}`,
      `**Profit & Loss**`,
      `💰 Total: **${fmtSigned(report.totalProfitPct * 100)}%** (${fmtSigned(report.totalProfitUsd, "$")})`,
      `📈 Best: **${fmtSigned(report.bestTradePct * 100)}%**`,
      `📉 Worst: **${fmtSigned(report.worstTradePct * 100)}%**`,
    ];

    if (Object.keys(report.reasons).length > 0) {
      lines.push(`${SEPARATOR}`);
      lines.push(`**Close Reasons**`);
      for (const [reason, count] of Object.entries(report.reasons)) {
        lines.push(`${closeIcon(reason)} **${closeLabel(reason)}**: \`${count}\``);
      }
    }

    return lines.join("\n");
  }
}
