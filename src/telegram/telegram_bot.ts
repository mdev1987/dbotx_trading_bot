import { Bot } from "grammy";
import { convert } from "telegram-markdown-v2";

import { Observable, Subject, Subscription, timer } from "rxjs";
import { concatMap, distinctUntilChanged, filter, map } from "rxjs/operators";

import { CONFIG } from "../config";
import { isSignalPaused, pauseSignals, resumeSignals } from "./telegram_client";

import type { PerformanceReport } from "../dbotx/types";

/* -------------------------------------------------------------------------- */
/*                            Telegram Bot Instance                           */
/* -------------------------------------------------------------------------- */

/**
 * Telegram Bot API client.
 *
 * This bot is responsible for:
 *
 * • Sending trade notifications
 * • Sending performance reports
 * • Handling simple operator commands
 *
 * It is completely independent from the MTProto Telegram client used
 * for listening to trading signals.
 */
const bot = new Bot(CONFIG.telegramBotToken!);

/**
 * Destination chat.
 *
 * Every report and notification is sent to this chat.
 */
const CHAT_ID = CONFIG.telegramChatId!;

/* -------------------------------------------------------------------------- */
/*                              Helper Functions                              */
/* -------------------------------------------------------------------------- */

/**
 * Formats a signed numeric value.
 *
 * Examples:
 *
 *  5.43   -> +5.43
 * -2.18   -> -2.18
 *
 * @param value Numeric value.
 * @param suffix Optional suffix (%, $, SOL...)
 */
function formatSigned(value: number, suffix = ""): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}${suffix}`;
}

/**
 * Converts milliseconds into a human readable duration.
 *
 * Examples:
 *
 * 42000     -> 42s
 * 125000    -> 2m 5s
 */
function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);

  if (minutes === 0) {
    return `${seconds}s`;
  }

  return `${minutes}m ${seconds % 60}s`;
}

/**
 * Returns an emoji representing a position close reason.
 */
function closeReasonIcon(reason: string): string {
  switch (reason) {
    case "take_profit":
      return "🟢";

    case "stop_loss":
      return "🔴";

    case "trailing_stop":
      return "🟡";

    case "expired":
      return "⏰";

    default:
      return "⚠️";
  }
}

/**
 * Converts an internal close reason into a user friendly label.
 */
function closeReasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    take_profit: "Take Profit",
    stop_loss: "Stop Loss",
    trailing_stop: "Trailing Stop",
    expired: "TTL Expired",
    manual: "Manual Close",
  };

  return labels[reason] ?? reason;
}

/* -------------------------------------------------------------------------- */
/*                           Reporter Dependencies                            */
/* -------------------------------------------------------------------------- */

/**
 * Dependencies injected into the reporter.
 *
 * The reporter intentionally knows nothing about the trading engine.
 * Instead, the engine provides these callbacks and observables.
 *
 * This keeps the module loosely coupled and easy to test.
 */
export interface ReporterCallbacks {
  /**
   * Returns the latest trading statistics.
   */
  getReport(): PerformanceReport;

  /**
   * Returns a formatted wallet balance string.
   */
  getBalanceStr(): string;

  /**
   * Emits whenever the set of open positions changes.
   */
  openPositions$: Observable<any[]>;

  /**
   * Emits position lifecycle events.
   */
  positionEvent$: Observable<any>;

  /**
   * Emits after a position has been closed.
   */
  positionClosed$: Observable<any>;
}

/* -------------------------------------------------------------------------- */
/*                           Telegram Reporter Class                          */
/* -------------------------------------------------------------------------- */

/**
 * Sends trading notifications to Telegram.
 *
 * Responsibilities:
 *
 * • Queue outgoing messages
 * • Retry failed sends
 * • Send open/close notifications
 * • Send periodic summaries
 * • Expose operator commands
 *
 * All outgoing messages are serialized through an internal queue to
 * prevent Telegram Bot API rate-limit issues.
 */
export class TelegramReporter {
  /**
   * Outgoing message queue.
   *
   * Messages are processed sequentially.
   */
  private readonly sendQueue$ = new Subject<string>();

  /**
   * Active RxJS subscriptions.
   */
  private readonly subscriptions: Subscription[] = [];

  /**
   * Trading engine callbacks.
   */
  private callbacks!: ReporterCallbacks;

  /**
   * Current number of open positions.
   *
   * Used by the /status command.
   */
  public openCount = 0;

  /**
   * Inject trading engine callbacks.
   *
   * Must be called before start().
   */
  wire(callbacks: ReporterCallbacks): void {
    this.callbacks = callbacks;
  }

  /**
   * Returns true when reporter callbacks have been injected.
   */
  private get isWired(): boolean {
    return this.callbacks !== undefined;
  }

  /* ------------------------------------------------------------------------ */
  /*                              Lifecycle                                   */
  /* ------------------------------------------------------------------------ */

  /**
   * Starts the reporter.
   *
   * Registers every required subscription exactly once.
   *
   * Responsibilities:
   *
   * • Process outgoing Telegram messages
   * • Track open positions
   * • Send position open notifications
   * • Send position close notifications
   * • Send periodic performance reports
   */
  start(): void {
    if (this.subscriptions.length > 0) {
      return;
    }

    if (!this.isWired) {
      throw new Error(
        "TelegramReporter.start() called before wire(). " +
          "Call reporter.wire(callbacks) first.",
      );
    }

    /* ---------------------------------------------------------------------- */
    /* Outgoing message queue                                                  */
    /* ---------------------------------------------------------------------- */

    this.subscriptions.push(
      this.sendQueue$
        .pipe(
          /**
           * Send one message at a time.
           *
           * Prevents Telegram Bot API flooding and preserves message order.
           */
          concatMap((message) => this.sendWithRetry(convert(message))),
        )
        .subscribe(),
    );

    /* ---------------------------------------------------------------------- */
    /* Track current number of open positions                                  */
    /* ---------------------------------------------------------------------- */

    this.subscriptions.push(
      this.callbacks.openPositions$.subscribe((positions) => {
        this.openCount = positions.length;
      }),
    );

    /* ---------------------------------------------------------------------- */
    /* Position opened notification                                            */
    /* ---------------------------------------------------------------------- */

    this.subscriptions.push(
      this.callbacks.positionEvent$
        .pipe(filter((event) => event.type === "opened"))
        .subscribe((event) => {
          try {
            this.enqueueMessage(this.buildOpenedMessage(event));
          } catch (error) {
            console.error("[Reporter] Failed to build opened message:", error);
          }
        }),
    );

    /* ---------------------------------------------------------------------- */
    /* Position closed notification                                            */
    /* ---------------------------------------------------------------------- */

    this.subscriptions.push(
      this.callbacks.positionClosed$.subscribe((event) => {
        try {
          this.enqueueMessage(this.buildClosedMessage(event));
        } catch (error) {
          console.error("[Reporter] Failed to build closed message:", error);
        }
      }),
    );

    /* ---------------------------------------------------------------------- */
    /* Periodic performance report                                             */
    /* ---------------------------------------------------------------------- */

    const intervalMs = CONFIG.reportIntervalMinutes * 60_000;

    if (intervalMs > 0) {
      this.subscriptions.push(
        timer(intervalMs, intervalMs)
          .pipe(
            map(() => {
              try {
                return this.callbacks.getReport();
              } catch {
                return null;
              }
            }),

            /**
             * Avoid sending duplicate reports.
             */
            distinctUntilChanged((previous, current) => {
              if (!previous || !current) {
                return false;
              }

              return JSON.stringify(previous) === JSON.stringify(current);
            }),

            filter((report): report is PerformanceReport => report !== null),
          )
          .subscribe((report) => {
            this.enqueueMessage(this.buildSummaryMessage(report));
          }),
      );
    }

    console.log("[Reporter] Started");
  }

  /**
   * Stops the reporter.
   *
   * Removes every subscription and stops Telegram polling.
   */
  stop(): void {
    for (const subscription of this.subscriptions) {
      subscription.unsubscribe();
    }

    this.subscriptions.length = 0;

    bot.stop();

    console.log("[Reporter] Stopped");
  }

  /* ------------------------------------------------------------------------ */
  /*                           Message Queue                                  */
  /* ------------------------------------------------------------------------ */

  /**
   * Adds a message to the outgoing queue.
   *
   * Messages are always sent sequentially.
   */
  sendMessage(message: string): void {
    this.enqueueMessage(message);
  }

  /**
   * Internal queue helper.
   */
  private enqueueMessage(message: string): void {
    this.sendQueue$.next(message);
  }

  /**
   * Sends a Telegram message with automatic retries.
   *
   * Uses exponential backoff to reduce the chance of hitting
   * Telegram rate limits or temporary network failures.
   *
   * @param message Telegram MarkdownV2 message.
   * @param maxRetries Maximum retry attempts.
   */
  private async sendWithRetry(message: string, maxRetries = 3): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await bot.api.sendMessage(CHAT_ID, message, {
          parse_mode: "MarkdownV2",
        });

        return;
      } catch (error) {
        if (attempt === maxRetries) {
          console.error("[Reporter] Failed to send Telegram message:", error);

          return;
        }

        const delay = 1000 * Math.pow(2, attempt - 1);

        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  /* ------------------------------------------------------------------------ */
  /*                         Telegram Message Builders                         */
  /* ------------------------------------------------------------------------ */

  /**
   * Builds a Telegram notification when a new position is opened.
   */
  private buildOpenedMessage(event: any): string {
    const position = event.position;

    const report = this.callbacks.getReport();

    const signal = position.signal ?? {};

    const lines: string[] = [
      "🟢 **Position Opened**",
      "",

      `🔒 Token: \`${position.tokenName}\``,

      `💰 Size: **${position.sizeSol.toFixed(2)} SOL**`,

      `🕒 Time: \`${new Date(position.openedAt).toLocaleTimeString()}\``,
    ];

    if (signal.maxPumpX != null && signal.maxPumpX > 0) {
      lines.push(`🚀 Max Pump: **x${signal.maxPumpX}**`);
    }

    lines.push("");

    lines.push(this.callbacks.getBalanceStr());

    lines.push(
      `📌 Positions: \`${report.openPositions} / ${CONFIG.maxPositions}\``,
    );

    return convert(lines.join("\n"));
  }

  /**
   * Builds a Telegram notification when a position closes.
   */
  private buildClosedMessage(event: any): string {
    const position = event.position;

    const report = this.callbacks.getReport();

    const profitPercent = position.currentProfitPercent ?? 0;

    const closeReason = position.closeReason ?? "unknown";

    const duration = formatDuration(
      (position.lastUpdateAt ?? Date.now()) - (position.openedAt ?? Date.now()),
    );

    const profitable = profitPercent >= 0;

    const lines: string[] = [
      `${profitable ? "🟢" : "🔴"} **Position Closed** ${
        profitable ? "✅" : "❌"
      }`,

      "",

      `🔒 Token: \`${position.tokenName}\``,
    ];

    if (position.entryPriceUsd != null) {
      lines.push(`💵 Entry: \`$${position.entryPriceUsd.toFixed(8)}\``);
    }

    lines.push(
      `🔗 Reason: ${closeReasonIcon(closeReason)} **${closeReasonLabel(closeReason)}**`,

      `⏱️ Duration: \`${duration}\``,

      "",

      this.callbacks.getBalanceStr(),

      `📌 Positions: \`${report.openPositions} / ${CONFIG.maxPositions}\``,
    );

    return convert(lines.join("\n"));
  }

  /**
   * Builds the periodic performance summary.
   */
  private buildSummaryMessage(report: PerformanceReport): string {
    const lines: string[] = [
      "📊 **Performance Report**",

      "",

      `Mode: ${
        CONFIG.liveMode ? "📡" : "🧪"
      } \`${CONFIG.liveMode ? "Live" : "Simulate"}\``,

      "",

      "────────────",

      "",

      this.callbacks.getBalanceStr(),

      "",

      `📌 Open Positions: \`${report.openPositions} / ${CONFIG.maxPositions}\``,

      `✅ Closed Positions: \`${report.closedPositions}\``,

      `📋 Total Positions: \`${report.totalPositions}\``,

      "",

      `${report.winRate >= 50 ? "🏆" : "⚠️"} **Trading Results**`,

      `✅ Wins: \`${report.winningTrades}\``,

      `❌ Losses: \`${report.losingTrades}\``,

      `🎯 Win Rate: **${report.winRate.toFixed(1)}%**`,

      "",

      "**Profit & Loss**",

      `💰 Total: **${formatSigned(report.totalProfitPct)}%** (${formatSigned(
        report.totalProfitUsd,
        "$",
      )})`,

      `📈 Best Trade: **${formatSigned(report.bestTradePct)}%**`,

      `📉 Worst Trade: **${formatSigned(report.worstTradePct)}%**`,
    ];

    if (Object.keys(report.reasons).length > 0) {
      lines.push("");

      lines.push("**Close Reasons**");

      for (const [reason, count] of Object.entries(report.reasons)) {
        lines.push(
          `${closeReasonIcon(reason)} **${closeReasonLabel(reason)}**: \`${count}\``,
        );
      }
    }

    return convert(lines.join("\n"));
  }
}
