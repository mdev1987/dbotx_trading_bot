/**
 * Application entry point.
 *
 * Initializes in order:
 *   1. Analytics persistence (SQLite).
 *   2. Telegram bot reporter.
 *   3. Telegram signal listener.
 *   4. Simulator or Live position manager (based on LIVE_MODE).
 *   5. Shutdown handlers.
 */
import { CONFIG } from "./config";
import {
  startPersistence,
  stopPersistence,
} from "./analytics/trades_repository";
import {
  startReporter,
  stopReporter,
  sendMessage,
} from "./telegram/telegram_bot_reporter";
import {
  startTelegramListener,
  stopTelegramListener,
  getTelegramClient,
  resetTelegramClient,
} from "./telegram/telegram_listener";
import { timer, Subscription } from "rxjs";
import { tap } from "rxjs/operators";
import { convert } from "telegram-markdown-v2";

/** Determine the signal-source mode from the configured Telegram channel name. */
let channel_mode: "ave" | "monitor";

if (CONFIG.telegramChannelUserName === "avesignalmonitor") {
  channel_mode = "monitor";
} else if (CONFIG.telegramChannelUserName === "avesolanatokenscanner") {
  channel_mode = "ave";
} else {
  throw new Error(
    `Unsupported telegram channel username: ${CONFIG.telegramChannelUserName}`,
  );
}

/** Reference to the live trading stop function (set after dynamic import). */
let stopLiveTradingFn: (() => void) | undefined;

/**
 * Initialize all systems and start the bot.
 */
async function start(): Promise<void> {
  // Step 1: Start persisting position lifecycle events to SQLite.
  startPersistence();

  // Step 2: Start the Telegram bot reporter.
  startReporter();

  // Step 3: Connect to Telegram and begin listening for trade signals.
  try {
    await startTelegramListener();
  } catch (err) {
    console.error("[main] Telegram listener failed to start:", err);
  }

  // Step 4: Start the position manager (simulator or live).
  if (CONFIG.liveMode) {
    await startLiveMode();
  } else {
    await startSimulatorMode();
  }

  // Step 5: Start Telegram health check watchdog.
  startTelegramWatchdog();

  // Step 6: Send the startup notification.
  await sendStartedMessage();
}

/**
 * Start the simulator position manager.
 * Side-effect import wires up its own subscriptions at module load time.
 */
async function startSimulatorMode(): Promise<void> {
  console.log("[main] Starting simulator mode...");

  // Import creates all subscriptions as module-level side effects.
  await import("./simulator/position_manager");

  // Subscribe to simulator account updates for console logging.
  const { simulatorAccount$ } = await import("./simulator/account");
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
}

/**
 * Start the live trading position manager.
 * Calls the exported init function explicitly.
 */
async function startLiveMode(): Promise<void> {
  console.log("[main] Starting live mode...");

  const liveModule = await import("./live/position_manager");
  stopLiveTradingFn = liveModule.stopLiveTrading;

  await liveModule.startLiveTrading();
}

/**
 * Format a duration in seconds to a human-readable string (e.g., "2m 30s").
 */
function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

/**
 * Build the startup message showing the current bot configuration.
 * @returns Telegram MarkdownV2 formatted startup message string.
 */
function startedMessage(): string {
  const modeLabel = CONFIG.liveMode ? "Live" : "Simulate";
  const modeIcon = CONFIG.liveMode ? "\u{1F4E1}" : "\u{1F9EA}"; // 📡 or 🧪

  const lines: string[] = [
    `\u{1F680} **Bot Started**`,              // 🚀 Bot Started
    "",
    `Mode: ${modeIcon} \`${modeLabel}\``,
  ];

  if (CONFIG.liveMode) {
    lines.push(`\u{1F512} Wallet: \`${process.env.LIVE_WALLET_ID ?? "?"}\``); // 🔒
  }

  // Position limit
  lines.push(`\u{1F4CC} Max Positions: \`${CONFIG.maxPositions}\``);

  // Position size with min/max and risk limit
  lines.push(
    `\u{1F4B0} Position: \`${CONFIG.positionSize.toFixed(2)} SOL\` ` +
      `(min \`${CONFIG.minPositionSol.toFixed(2)}\` / ` +
      `max \`${CONFIG.maxPositionSol.toFixed(2)}\` ` +
      `risk \u{2264}\`${CONFIG.maxRiskPct.toFixed(1)}%\` of balance)`,
  );

  // TTL settings
  if (channel_mode === "ave") {
    lines.push(
      `\u{23F0} Base TTL: \`${fmtDuration(CONFIG.baseTtlSecs)}\`` +
        (CONFIG.minProfitForTtlExtensionPct > 0
          ? ` \u{1F504} renew \u{2265}\`${(CONFIG.minProfitForTtlExtensionPct * 100).toFixed(1)}%\``
          : "") +
        ` | Max: \`${fmtDuration(CONFIG.maxTtlSecs)}\``,
    );
  }

  // Exit settings
  lines.push("", "**Exit Settings**");

  if (channel_mode === "monitor") {
    lines.push(`\u{1F7E2} TP: \`from signal maxPumpX\``);
  }

  if (CONFIG.stopLossPct) {
    lines.push(
      `\u{1F534} Stop Loss: \`${(CONFIG.stopLossPct * 100).toFixed(1)}%\``,
    );
  }

  if (channel_mode === "ave") {
    if (CONFIG.partialTpTiers.length > 0) {
      const tiers = CONFIG.partialTpTiers
        .map((t) => `${(t.pct * 100).toFixed(0)}%@${(t.at * 100).toFixed(0)}%`)
        .join(", ");
      lines.push(`\u{1F7E2} Partial TP: \`${tiers}\``);
    }
    if (CONFIG.backstopTpPct) {
      lines.push(
        `\u{1F7E2} Backstop TP: \`${(CONFIG.backstopTpPct * 100).toFixed(0)}%\``,
      );
    }
    if (CONFIG.minProfitForTtlExtensionPct > 0) {
      lines.push(
        `\u{1F504} TTL Extension: \u{2265}\`${(CONFIG.minProfitForTtlExtensionPct * 100).toFixed(1)}%\` profit to renew`,
      );
    }
    if (CONFIG.signalQueueSize > 0) {
      lines.push(`\u{1F4E6} Signal Queue: \`${CONFIG.signalQueueSize}\` slots`);
    }
  }

  if (CONFIG.trailingDistancePct) {
    // Note: trailingDistancePct in config is reading PAPER_TRAILING_STOP_PERCENT
    // We display the live equivalent
    lines.push(
      `\u{1F7E1} Trailing: \`${(CONFIG.trailingActivationPct * 100).toFixed(0)}%\` activation, ` +
        `\`${(CONFIG.trailingDistancePct * 100).toFixed(0)}%\` distance`,
    );
  }

  return convert(lines.join("\n"));
}

/**
 * Send the startup notification (best-effort, non-critical).
 */
async function sendStartedMessage(): Promise<void> {
  try {
    await sendMessage(startedMessage());
  } catch { /* best-effort */ }
}

/**
 * Build and send the shutdown notification with a performance summary.
 */
async function sendStoppedMessage(error?: string): Promise<void> {
  try {
    const { generateReport } = await import("./analytics/reports");

    const lines: string[] = [];

    if (error) {
      lines.push(`\u{1F4A5} **Bot Crashed**`);
      lines.push("");
      lines.push(`Error: \`${error}\``);
      lines.push("");
    } else {
      lines.push(`\u{1F6D1} **Bot Stopped**`);
      lines.push("");
    }

    const report = generateReport();
    const balIcon = report.totalProfitUsd >= 0 ? "\u{1F7E2}" : "\u{1F534}";
    const winIcon = report.winRate >= 50 ? "\u{1F3C6}" : "\u{26A0}\uFE0F";

    lines.push(`\u{1F4CA} **Summary**`);
    lines.push(`\u{1F4CB} Total: \`${report.totalPositions}\``);
    lines.push(
      `\u{1F4CC} Open: \`${report.openPositions}\`` +
        (channel_mode === "ave" ? ` / ${CONFIG.maxPositions}` : ""),
    );
    lines.push(`\u{2705} Closed: \`${report.closedPositions}\``);
    lines.push(
      `${winIcon} Wins: \`${report.winningTrades}\` / \`${report.losingTrades}\` (\`${report.winRate.toFixed(1)}%\`)`,
    );
    lines.push(
      `${balIcon} Total PnL: \`${report.totalProfitPct.toFixed(2)}%\` (\`$${report.totalProfitUsd.toFixed(2)}\`)`,
    );

    if (Object.keys(report.reasons).length > 0) {
      lines.push("");
      lines.push("**Close Reasons**");
      for (const [r, count] of Object.entries(report.reasons)) {
        lines.push(`  ${r}: \`${count}\``);
      }
    }

    await sendMessage(convert(lines.join("\n")));
  } catch { /* best-effort */ }
}

// ──────────────────────────────────────────────
// Telegram Watchdog
// ──────────────────────────────────────────────

let _tgWatchdogSub: Subscription | undefined;

/**
 * Periodically verify the Telegram connection and restart the listener
 * if the client is no longer authorised.
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
 * Restart the Telegram listener from scratch.
 */
async function restartTelegram(): Promise<void> {
  try { await stopTelegramListener(); } catch { /* ok */ }
  resetTelegramClient();
  await new Promise((r) => setTimeout(r, 2000));
  try { await startTelegramListener(); } catch (err) {
    console.error("[watchdog] Telegram restart failed:", err);
  }
}

// ══════════════════════════════════════════════
// Application entry
// ══════════════════════════════════════════════

start().catch((err) => {
  console.error("[main] Startup failed:", err);
  process.exit(1);
});

let _shuttingDown = false;

/**
 * Gracefully shut down all subsystems and exit.
 */
async function shutdown(error?: string): Promise<void> {
  if (_shuttingDown) return;
  _shuttingDown = true;

  console.log("\n[main] Shutting down...");

  // Send shutdown notification to Telegram (best-effort).
  await sendStoppedMessage(error);

  // Stop live trading if active.
  if (stopLiveTradingFn) {
    try {
      stopLiveTradingFn();
    } catch (err) {
      console.error("[main] Live trading stop failed:", err);
    }
  }

  // Stop the Telegram watchdog health check timer.
  _tgWatchdogSub?.unsubscribe();

  // Tear down subsystems in reverse order of initialization.
  stopReporter();
  stopPersistence();
  await stopTelegramListener().catch(() => {});

  // Print the final performance report.
  const { printReport, generateReport } = await import("./analytics/reports");
  printReport(generateReport());

  process.exit(error ? 1 : 0);
}

process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error("[main] Unhandled rejection:", msg);
  shutdown(msg);
});
process.on("uncaughtException", (err) => {
  console.error("[main] Uncaught exception:", err.message);
  shutdown(err.message);
});
