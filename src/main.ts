// Application entry point — initializes persistence, Telegram reporter,
// Telegram listener, and simulator position manager
import "./simulator/position_manager"; // Side-effect import: wires up its own subscriptions
import {
  startPersistence,
  stopPersistence,
} from "./analytics/trades_repository"; // Persistence lifecycle
import {
  startReporter,
  stopReporter,
  sendMessage,
} from "./telegram/telegram_bot_reporter"; // Reporter lifecycle
import {
  startTelegramListener,
  stopTelegramListener,
  getTelegramClient,
  resetTelegramClient,
} from "./telegram/telegram_listener"; // Listener lifecycle
import { simulatorAccount$ } from "./simulator/account"; // Simulator account stream for balance logging
import { CONFIG } from "./config"; // Configuration constants
import { timer, Subscription } from "rxjs";
import { tap } from "rxjs/operators";
import { convert } from "telegram-markdown-v2"; // Markdown converter for Telegram

// Determine the signal-source mode from the configured Telegram channel name
let channel_mode: "ave" | "monitor";

if (CONFIG.telegramChannelUserName === "avesignalmonitor") {
  // Ave Signal Monitor → pump-detection mode (no position limit)
  channel_mode = "monitor";
} else if (CONFIG.telegramChannelUserName === "avesolanatokenscanner") {
  // Ave Solana Token Scanner → scanner-trade mode (configurable position limit)
  channel_mode = "ave";
} else {
  // Unknown channel — fail fast at startup before any systems initialize
  throw new Error(
    `Unsupported telegram channel username: ${CONFIG.telegramChannelUserName}`,
  );
}

/**
 * Initialize all systems and start the bot.
 *
 * Sets up persistence, reporter, Telegram listener, account logging,
 * and sends the startup notification.
 *
 * @throws On critical initialization failures (non-critical errors are logged).
 * @returns Resolves once all subsystems are started.
 */
async function start(): Promise<void> {
  // Step 1: Start persisting position lifecycle events to SQLite
  startPersistence();
  // Step 2: Start the Telegram bot reporter (queues formatted messages for delivery)
  startReporter();

  try {
    // Step 3: Connect to Telegram and begin listening for trade signals
    await startTelegramListener();
  } catch (err) {
    // Telegram listener is non-critical — bot can simulate without live signals
    console.error("[main] Telegram listener failed to start:", err);
  }

  // Step 4: Subscribe to simulator account updates and log to console
  simulatorAccount$
    .pipe(
      tap((acct) => {
        console.log(
          `[ACCT] Balance=\$${acct.balance.toFixed(2)}` +
            ` | PnL=${(acct.changeAll * 100).toFixed(2)}%` +
            ` | Tokens=${acct.holdTokens}`,
        );
      }),
    )
    .subscribe();

  // Step 5: Start Telegram health check — periodically verify the MTProto
  // connection and restart the listener on failure (teleproto's built-in
  // auto-reconnect is unreliable after ~6 minutes).
  startTelegramWatchdog();

  // Step 6: Send the startup notification to the configured Telegram chat
  await sendStartedMessage();
}

/**
 * Format a duration in seconds to a human-readable string (e.g., "2m 30s")
 * @param seconds - Duration in seconds
 * @returns Formatted duration string
 */
function fmtDuration(seconds: number): string {
  // Return seconds only if under 60
  if (seconds < 60) return `${seconds}s`;
  // Calculate minutes and remaining seconds
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  // Include seconds only if non-zero
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

/**
 * Build the startup message showing the current bot configuration.
 *
 * Conditionally includes sections based on channel_mode (monitor vs ave).
 *
 * @returns Telegram MarkdownV2 formatted startup message string.
 */
function startedMessage(): string {
  // Start with header and simulation mode badge
  const lines: string[] = [
    "\u{1F680} **Bot Started**",          // 🚀 Bot Started
    "",
    `Mode: \u{1F9EA} \`Simulate\``,       // 🧪 Simulate
  ];

  // Position limit
  lines.push(`\u{1F4CC} Max Positions: \`${CONFIG.maxPositions}\``); // 📌

  // Position size with min/max and risk limit
  lines.push(
    `\u{1F4B0} Position: \`${CONFIG.positionSize.toFixed(2)} SOL\` (min \`${CONFIG.minPositionSol.toFixed(2)}\` / max \`${CONFIG.maxPositionSol.toFixed(2)}\` risk \u{2264}\`${CONFIG.maxRiskPct.toFixed(1)}%\` of balance)`,
  ); // 💰

  // TTL settings (only relevant in AVE scanner mode)
  if (channel_mode === "ave") {
    lines.push(
      `\u{23F0} Base TTL: \`${fmtDuration(CONFIG.baseTtlSecs)}\`` +     // ⏰ base
        (CONFIG.minProfitForTtlExtensionPct > 0
          ? ` \u{1F504} renew \u{2265}\`${(CONFIG.minProfitForTtlExtensionPct * 100).toFixed(1)}%\`` // 🔄 renewal threshold
          : "") +
        ` | Max: \`${fmtDuration(CONFIG.maxTtlSecs)}\``,
    );
  }

  // Exit settings section header
  lines.push("", "**Exit Settings**");

  // Take-profit for monitor mode — uses the signal's maxPumpX value
  if (channel_mode === "monitor") {
    lines.push(`\u{1F7E2} TP: \`from signal maxPumpX\``); // 🟢
  }

  // Fixed stop-loss percentage
  if (CONFIG.stopLossPct) {
    lines.push(
      `\u{1F534} Stop Loss: \`${(CONFIG.stopLossPct * 100).toFixed(1)}%\``,
    ); // 🔴
  }

  // AVE-specific exit configuration block
  if (channel_mode === "ave") {
    // Partial take-profit tiers (e.g. 25%@50%, 25%@100%)
    if (CONFIG.partialTpTiers.length > 0) {
      const tiers = CONFIG.partialTpTiers
        .map((t) => `${(t.pct * 100).toFixed(0)}%@${(t.at * 100).toFixed(0)}%`)
        .join(", ");
      lines.push(`\u{1F7E2} Partial TP: \`${tiers}\``); // 🟢
    }
    // Backstop take-profit as a safety net
    if (CONFIG.backstopTpPct) {
      lines.push(
        `\u{1F7E2} Backstop TP: \`${(CONFIG.backstopTpPct * 100).toFixed(0)}%\``,
      ); // 🟢
    }
    // TTL extension: minimum profit needed to renew position lifetime
    if (CONFIG.minProfitForTtlExtensionPct > 0) {
      lines.push(
        `\u{1F504} TTL Extension: \u{2265}\`${(CONFIG.minProfitForTtlExtensionPct * 100).toFixed(1)}%\` profit to renew`, // 🔄 ≥
      );
    }
    // Signal queue size for rate-limiting incoming signals
    if (CONFIG.signalQueueSize > 0) {
      lines.push(`\u{1F4E6} Signal Queue: \`${CONFIG.signalQueueSize}\` slots`); // 📦
    }
  }

  // Trailing stop activation distance and trailing distance
  if (CONFIG.trailingDistancePct) {
    lines.push(
      `\u{1F7E1} Trailing: \`${(CONFIG.trailingActivationPct * 100).toFixed(0)}%\` activation, ` + // 🟡
        `\`${(CONFIG.trailingDistancePct * 100).toFixed(0)}%\` distance`,
    );
  }

  // Convert markdown to Telegram MarkdownV2 format
  return convert(lines.join("\n"));
}

/**
 * Send the startup notification (best-effort, non-critical).
 *
 * @returns Resolves when sent (or silently caught on failure).
 */
async function sendStartedMessage(): Promise<void> {
  try {
    await sendMessage(startedMessage());
  } catch {
    // Best-effort — don't crash if sending fails
  }
}

/**
 * Build and send the shutdown notification with a performance summary.
 *
 * Dynamically imports generateReport to avoid circular dependency.
 *
 * @param error - Optional error message if the bot crashed.
 * @returns Resolves when sent (or silently caught on failure).
 */
async function sendStoppedMessage(error?: string): Promise<void> {
  try {
    // Import dynamically to avoid circular dependency on startup
    const { generateReport } = await import("./analytics/reports");

    const lines: string[] = [];

    if (error) {
      // Crash message with error details
      lines.push(`\u{1F4A5} **Bot Crashed**`); // 💥
      lines.push("");
      lines.push(`Error: \`${error}\``);
      lines.push("");
    } else {
      // Normal stop message
      lines.push(`\u{1F6D1} **Bot Stopped**`); // 🛑
      lines.push("");
    }

    // Generate and format the performance report
    const report = generateReport();
    const balIcon = report.totalProfitUsd >= 0 ? "\u{1F7E2}" : "\u{1F534}"; // 🟢 or 🔴
    const winIcon = report.winRate >= 50 ? "\u{1F3C6}" : "\u{26A0}\uFE0F"; // 🏆 or ⚠️

    lines.push(`\u{1F4CA} **Summary**`); // 📊
    lines.push(`\u{1F4CB} Total: \`${report.totalPositions}\``); // 📋
    lines.push(
      `\u{1F4CC} Open: \`${report.openPositions}\`` +
        (channel_mode === "ave" ? ` / ${CONFIG.maxPositions}` : ""),
    ); // 📌
    lines.push(`\u{2705} Closed: \`${report.closedPositions}\``); // ✅
    lines.push(
      `${winIcon} Wins: \`${report.winningTrades}\` / \`${report.losingTrades}\` (\`${report.winRate.toFixed(1)}%\`)`,
    );
    lines.push(
      `${balIcon} Total PnL: \`${report.totalProfitPct.toFixed(2)}%\` (\`$${report.totalProfitUsd.toFixed(2)}\`)`,
    );

    // Close reason breakdown
    if (Object.keys(report.reasons).length > 0) {
      lines.push("");
      lines.push("**Close Reasons**");
      for (const [r, count] of Object.entries(report.reasons)) {
        lines.push(`  ${r}: \`${count}\``);
      }
    }

    await sendMessage(convert(lines.join("\n")));
  } catch {
    // Best-effort — don't crash if sending fails
  }
}

// ──────────────────────────────────────────────
// Telegram Watchdog
// ──────────────────────────────────────────────

let _tgWatchdogSub: Subscription | undefined;

/**
 * Periodically verify the Telegram connection and restart the listener if
 * the client is no longer authorised.
 *
 * Teleproto's built-in `autoReconnect` often fails silently (TIMEOUT pings,
 * "connection closed while receiving data"), so this watchdog detects stale
 * connections and forces a full re-authentication cycle.
 *
 * Runs every 60 seconds. Restarts involve calling resetTelegramClient() to
 * create a fresh MTProto client, then startTelegramListener() to re-auth.
 */
function startTelegramWatchdog(): void {
  _tgWatchdogSub = timer(CONFIG.tgRetryDelayMs, 60_000)
    .pipe(
      tap(async () => {
        if (_shuttingDown) return;
        try {
          const client = getTelegramClient();
          const ok = await client.checkAuthorization();
          if (!ok) {
            console.warn("[watchdog] Telegram not authorized — restarting");
            await restartTelegram();
          }
        } catch (err) {
          console.warn("[watchdog] Telegram health check failed — restarting:", err);
          await restartTelegram();
        }
      }),
    )
    .subscribe();
}

/**
 * Restart the Telegram listener from scratch: stop, reset the client,
 * then start again. Silent on errors (non-critical).
 */
async function restartTelegram(): Promise<void> {
  try {
    await stopTelegramListener();
  } catch { /* ok */ }
  resetTelegramClient();
  // Small delay to let network state settle before reconnecting
  await new Promise((r) => setTimeout(r, 2000));
  try {
    await startTelegramListener();
  } catch (err) {
    console.error("[watchdog] Telegram restart failed:", err);
  }
}

// ══════════════════════════════════════════════
// Application entry
// ══════════════════════════════════════════════

// Start the application
start().catch((err) => {
  console.error("[main] Startup failed:", err);
  process.exit(1);
});

// Guard flag to prevent multiple shutdown sequences
let _shuttingDown = false;

/**
 * Gracefully shut down all subsystems and exit the process.
 *
 * Sends a shutdown notification, stops all services,
 * prints the final report, then exits with the appropriate code.
 *
 * @param error - Optional error message for crash reporting.
 * @returns Never resolves — calls process.exit() internally.
 */
async function shutdown(error?: string): Promise<void> {
  // Guard: prevent multiple simultaneous shutdown sequences
  if (_shuttingDown) return;
  _shuttingDown = true;

  console.log("\n[main] Shutting down...");

  // Send shutdown notification to Telegram (best-effort)
  await sendStoppedMessage(error);

  // Stop the Telegram watchdog health check timer
  _tgWatchdogSub?.unsubscribe();

  // Tear down subsystems in reverse order of initialization
  stopReporter();
  stopPersistence();
  await stopTelegramListener().catch(() => {});

  // Print the final performance report to console for reference
  const { printReport, generateReport } = await import("./analytics/reports");
  printReport(generateReport());

  // Exit with code 1 if there was an error, 0 for clean shutdown
  process.exit(error ? 1 : 0);
}

// Graceful shutdown on Ctrl+C (SIGINT) or termination signal (SIGTERM)
process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());
// Catch unhandled promise rejections — log and attempt graceful shutdown
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error("[main] Unhandled rejection:", msg);
  shutdown(msg);
});
// Catch uncaught exceptions — log details and attempt graceful shutdown
process.on("uncaughtException", (err) => {
  console.error("[main] Uncaught exception:", err.message);
  shutdown(err.message);
});
