import { CONFIG } from "./config";                                          // Application configuration
import { LIVE_CONFIG } from "./live/config";                                // Live trading configuration
import { maskWalletId } from "./shared/mask";                               // Wallet ID/address masking
import {
  startPersistence,
  stopPersistence,
} from "./analytics/trades_repository";                                      // Trade analytics persistence layer
import {
  startReporter,
  stopReporter,
  sendMessage,
} from "./telegram/telegram_bot_reporter";                                   // Telegram bot message sender
import {
  startTelegramListener,
  stopTelegramListener,
  getTelegramClient,
  resetTelegramClient,
} from "./telegram/telegram_listener";                                       // Telegram client (MTProto) listener
import { timer, Subscription } from "rxjs";                                  // RxJS timer for periodic tasks
import { tap } from "rxjs/operators";                                        // Tap operator for side effects
import { convert } from "telegram-markdown-v2";                              // MarkdownV2 converter for Telegram messages
import { initBridge } from "./shared/trade_bridge";                          // Shared event bridge initialisation
import type { BridgeConfig } from "./shared/trade_bridge";                   // Bridge configuration type

// ── Mode ─────────────────────────────────────────────────────────────────────

/**
 * Determines which channel mode the bot runs in based on the configured
 * Telegram channel username:
 * - "avesignalmonitor"       → monitor mode (signal relay / monitor)
 * - "avesolanatokenscanner"  → ave mode (automated trading)
 */
const channelMode: "ave" | "monitor" = (() => {  // Resolve channel mode from config
  const ch = CONFIG.telegramChannelUserName;  // Read channel username from config
  if (ch === "avesignalmonitor") return "monitor";  // Signal monitor channel → monitor mode
  if (ch === "avesolanatokenscanner") return "ave";  // Token scanner channel → ave mode
  throw new Error(`Unsupported telegram channel username: ${ch}`);  // Unknown channel
})();  // IIFE: evaluate immediately on module load

// ── Shutdown State ──────────────────────────────────────────────────────────

/** Flag to prevent re-entrant shutdown sequences */
let _shuttingDown = false;  // Guards against concurrent shutdown calls
/** Reference to the live trading stop function, set during startLiveMode */
let stopLiveTradingFn: (() => void) | undefined;  // Live mode stop handle
/** Reference to the simulator trading stop function, set during startSimulatorMode */
let stopSimTradingFn: (() => void) | undefined;  // Simulator mode stop handle
/** Subscription handle for the periodic Telegram health watchdog */
let _tgWatchdogSub: Subscription | undefined;  // Watchdog subscription reference

// ── Bootstrap ───────────────────────────────────────────────────────────────

/**
 * Main application bootstrap. Initialises Telegram, starts the chosen
 * trading mode (live or simulator), wires up the event bridge,
 * analytics, and the Telegram bot reporter, then sends a startup message.
 */
async function start(): Promise<void> {
  // Step 1: Connect to Telegram (listener for incoming signals)
  try {
    await startTelegramListener();       // Establish MTProto connection to receive signal messages
  } catch (err) {
    console.error("[main] Telegram listener failed to start:", err);  // Log but continue — non-fatal
  }

  // Step 2: Start position manager — live trading or simulator
  let bridgeConfig: BridgeConfig;        // Will hold the event bridge wiring config

  if (CONFIG.liveMode) {
    bridgeConfig = await startLiveMode();        // Live trading on real blockchain
  } else {
    bridgeConfig = await startSimulatorMode();   // Paper trading on simulator
  }

  // Step 3: Wire the shared event bridge that connects position manager to the rest of the app
  initBridge(bridgeConfig);              // Connect position event streams to analytics & reporter

  // Step 4: Start analytics persistence (write trades to disk/DB)
  startPersistence();                    // Begin writing trade records to persistent storage

  // Step 5: Start Telegram bot reporter (sends status updates)
  startReporter();                       // Enable bot-driven status messages via Telegram

  // Step 6: Start periodic Telegram health check watchdog
  startTelegramWatchdog();               // Schedule heartbeat checks for Telegram connectivity

  // Step 7: Send a startup notification to the Telegram channel
  await sendStartedMessage();            // Post "Bot Started" announcement with config summary
}

// ── Live Mode ───────────────────────────────────────────────────────────────

/**
 * Initialises live trading mode on the real blockchain:
 * imports the live position manager, starts it, and builds a BridgeConfig
 * that exposes position streams and report-generating helpers.
 */
async function startLiveMode(): Promise<BridgeConfig> {
  console.log("[main] Starting live mode...");       // Log mode transition

  // Dynamically import the live trading module
  const liveModule = await import("./live/position_manager");  // Load live position manager bundle
  stopLiveTradingFn = liveModule.stopLiveTrading;              // Save stop handle for later
  await liveModule.startLiveTrading();                          // Start live position management

  // Import wallet module for balance display
  const wallet = await import("./live/wallet");       // Load wallet module for SOL balance display

  return {
    // Expose live position event streams
    positionEvent$: liveModule.positionEvent$,       // Live position lifecycle event stream
    positionClosed$: liveModule.positionClosed$,     // Stream of closed position events
    openPositions$: liveModule.openPositions$,       // Observable of currently open positions
    // Stub report — live mode does not yet generate detailed analytics
    getReport: () => {                                // Generate a placeholder performance report
      const openCount = liveModule.countOpenPositions();  // Count currently open positions
      if (!LIVE_CONFIG.liveBuyEnabled) {
        return liveModule.getPaperReport();
      }
      return {
        totalPositions: 0,                           // Not tracked in live mode yet
        closedPositions: 0,                          // Not tracked in live mode yet
        openPositions: openCount,                    // Currently open position count
        winningTrades: 0,                            // Not tracked in live mode yet
        losingTrades: 0,                             // Not tracked in live mode yet
        winRate: 0,                                  // Not tracked in live mode yet
        totalProfitUsd: 0,                           // Not tracked in live mode yet
        totalProfitPct: 0,                           // Not tracked in live mode yet
        avgProfitPct: 0,                             // Not tracked in live mode yet
        avgProfitUsd: 0,                             // Not tracked in live mode yet
        bestTradePct: 0,                             // Not tracked in live mode yet
        worstTradePct: 0,                            // Not tracked in live mode yet
        reasons: {},                                 // Not tracked in live mode yet
      };
    },
    // Format wallest balance string for bot messages
    getBalanceStr: () => {                            // Build formatted balance string for Telegram
      if (!LIVE_CONFIG.liveBuyEnabled) {
        const bal = liveModule.getPaperBalanceSol();
        const pnl = liveModule.getPaperRealizedPnLSol();
        const sign = pnl >= 0 ? "+" : "";
        return `\u{1F4DD} Paper: \`${bal.toFixed(2)} SOL\` (PnL: \`${sign}${pnl.toFixed(2)} SOL\`)`;
      }
      if (wallet.latestBalance) {                    // Check if balance data is available
        return `\u{1F4B0} Balance: \`${wallet.latestBalance.balanceSol.toFixed(2)} SOL\``;
      }
      return "";                                     // Return empty if no balance data
    },
  };
}

// ── Simulator Mode ──────────────────────────────────────────────────────────

/**
 * Initialises simulator (paper trading) mode:
 * imports the simulator position manager, starts it, subscribes to the
 * simulator account observable for logging, and builds a BridgeConfig
 * backed by the simulator's analytics report generator.
 */
async function startSimulatorMode(): Promise<BridgeConfig> {
  console.log("[main] Starting simulator mode...");  // Log mode transition

  // Dynamically import the simulator trading module
  const simModule = await import("./simulator/position_manager");  // Load simulator position manager bundle
  stopSimTradingFn = simModule.stopSimulatorTrading;              // Save stop handle for later
  await simModule.startSimulatorTrading();                          // Start simulator subsystems

  // Import simulator account stream for balance logging
  const { simulatorAccount$, latestAccount } = await import("./simulator/account");  // Load account observables
  // Subscribe to account updates and log balance/PnL to console
  simulatorAccount$
    .pipe(
      tap((acct) => {                                // Side-effect: log each account state update
        console.log(
          `[ACCT] Balance=\$${acct.balance.toFixed(2)}` +         // Current balance in USD
            ` | PnL=${(acct.changeAll * 100).toFixed(2)}%` +     // Overall PnL as percentage
            ` | Tokens=${acct.holdTokens}`,                       // Number of tokens held
        );
      }),
    )
    .subscribe();                                    // Activate the account logging subscription

  // Import the analytics report generator
  const { generateReport } = await import("./analytics/reports");  // Load report generator for summary stats

  return {
    // Expose simulator position event streams
    positionEvent$: simModule.positionEvent$,       // Simulator position lifecycle event stream
    positionClosed$: simModule.positionClosed$,     // Stream of closed position events
    openPositions$: simModule.openPositions$,       // Observable of currently open positions
    // Use the full analytics report generator from the reports module
    getReport: generateReport,                       // Full analytics report function for performance summary
    // Format simulator account balance with PnL indicator and colour icon
    getBalanceStr: () => {                           // Build formatted balance string for Telegram
      if (latestAccount) {                          // Check if account snapshot is available
        const change = latestAccount.changeAll;     // Overall PnL change ratio
        const icon = change >= 0 ? "\u{1F7E2}" : "\u{1F534}";  // Green/red circle
        const sign = change >= 0 ? "+" : "";        // Sign prefix for the percentage
        return `${icon} \u{1F4B0} Balance: \`$${latestAccount.balance.toFixed(2)}\` (\`${sign}${(change * 100).toFixed(2)}%\`)`;
      }
      return "";                                     // Return empty if no account data
    },
  };
}

// ── Startup / Shutdown Messages ─────────────────────────────────────────────

/**
 * Formats a duration in seconds into a human-readable string (e.g. "2m 30s").
 * Omits the seconds part when it is zero.
 */
function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;         // Less than a minute — just seconds
  const m = Math.floor(seconds / 60);              // Whole minutes
  const s = seconds % 60;                          // Remaining seconds
  return s > 0 ? `${m}m ${s}s` : `${m}m`;          // Omit seconds if zero
}

/**
 * Builds a startup announcement message with mode, position limits,
 * exit settings, and trailing stop configuration. Output is formatted
 * as Telegram MarkdownV2 via the `convert` helper.
 */
function startedMessage(): string {
  const modeLabel = CONFIG.liveMode ? "Live" : "Simulate";  // Resolve display label for bot mode
  const modeIcon = CONFIG.liveMode ? "\u{1F4E1}" : "\u{1F9EA}";  // Satellite or lab icon

  // Basic header with mode indicator
  const lines: string[] = [
    `\u{1F680} **Bot Started**`,                     // Rocket emoji header
    "",
    `Mode: ${modeIcon} \`${modeLabel}\``,            // Mode line with icon and label
  ];

  // Live-mode-specific wallet and buy-enable info
  if (CONFIG.liveMode) {
    lines.push(`\u{1F512} Wallet: \`${maskWalletId(process.env.LIVE_WALLET_ID ?? "?")}\``);  // Wallet ID from env
    const buyEnabled = (process.env.LIVE_BUY_ENABLED ?? "true").toLowerCase() === "true";  // Buy toggle
    lines.push(`\u{1F6E1}\uFE0F Buy: \`${buyEnabled ? "ENABLED" : "PAPER (disabled)"}\``);  // Buy status
  }

  // Position limits (max count, size range, risk cap)
  lines.push(`\u{1F4CC} Max Positions: \`${CONFIG.maxPositions}\``);  // Maximum concurrent positions
  lines.push(
    `\u{1F4B0} Position: \`${CONFIG.positionSize.toFixed(2)} SOL\` ` +     // Default position size
      `(min \`${CONFIG.minPositionSol.toFixed(2)}\` / ` +                   // Minimum SOL per position
      `max \`${CONFIG.maxPositionSol.toFixed(2)}\` ` +                      // Maximum SOL per position
      `risk \u{2264}\`${CONFIG.maxRiskPct.toFixed(1)}%\` of balance)`,     // Risk cap as % of balance
  );

  // TTL settings for ave mode (auto-renewal for profitable positions)
  if (channelMode === "ave") {
    lines.push(
      `\u{23F0} Base TTL: \`${fmtDuration(CONFIG.baseTtlSecs)}\`` +        // Base TTL duration
        (CONFIG.minProfitForTtlExtensionPct > 0
          ? ` \u{1F504} renew \u{2265}\`${(CONFIG.minProfitForTtlExtensionPct * 100).toFixed(1)}%\``
          : "") +                                                           // Auto-renewal threshold
        ` | Max: \`${fmtDuration(CONFIG.maxTtlSecs)}\``,                   // Hard TTL cap
    );
  }

  // Exit settings header
  lines.push("", "**Exit Settings**");               // Section header for exit configuration

  // Monitor mode: TP is derived from signal maxPumpX
  if (channelMode === "monitor") {
    lines.push(`\u{1F7E2} TP: \`from signal maxPumpX\``);  // TP determined by incoming signal
  }

  // Global stop-loss percentage
  if (CONFIG.stopLossPct) {
    lines.push(`\u{1F534} Stop Loss: \`${(CONFIG.stopLossPct * 100).toFixed(1)}%\``);  // Fixed stop-loss level
  }

  // AVE-specific: partial TP tiers, backstop TP, signal queue
  if (channelMode === "ave") {
    if (CONFIG.partialTpTiers.length > 0) {          // Partial take-profit tiers configured
      const tiers = CONFIG.partialTpTiers
        .map((t) => `${(t.pct * 100).toFixed(0)}%@${(t.at * 100).toFixed(0)}%`)  // Format: "%profit@%price"
        .join(", ");
      lines.push(`\u{1F7E2} Partial TP: \`${tiers}\``);  // Partial TP summary line
    }
    if (CONFIG.backstopTpPct) {                       // Backstop TP configured
      lines.push(`\u{1F7E2} Backstop TP: \`${(CONFIG.backstopTpPct * 100).toFixed(0)}%\``);  // Backstop level
    }
    if (CONFIG.signalQueueSize > 0) {                 // Signal queue enabled
      lines.push(`\u{1F4E6} Signal Queue: \`${CONFIG.signalQueueSize}\` slots`);  // Queue capacity
    }
  }

  // Trailing stop configuration (activation + distance)
  if (CONFIG.trailingDistancePct) {                   // Trailing stop enabled
    lines.push(
      `\u{1F7E1} Trailing: \`${(CONFIG.trailingActivationPct * 100).toFixed(0)}%\` activation, ` +
        `\`${(CONFIG.trailingDistancePct * 100).toFixed(0)}%\` distance`,  // Activation threshold + trail distance
    );
  }

  return convert(lines.join("\n"));  // Convert to Telegram MarkdownV2
}

/**
 * Sends the startup announcement to Telegram. Failures are silently ignored.
 */
async function sendStartedMessage(): Promise<void> {
  try {
    await sendMessage(startedMessage());
  } catch { /* best-effort — startup notification is non-critical */ }
}

/**
 * Sends a shutdown or crash notification to Telegram with a performance summary,
 * including total positions, win rate, PnL, and close-reason breakdown.
 */
async function sendStoppedMessage(error?: string): Promise<void> {
  try {
    // Dynamically import the bridge to get the latest report
    const { getReport } = await import("./shared/trade_bridge");

    const lines: string[] = [];

    // Header: crash vs graceful stop
    if (error) {
      lines.push(`\u{1F4A5} **Bot Crashed**`);
      lines.push("");
      lines.push(`Error: \`${error}\``);
      lines.push("");
    } else {
      lines.push(`\u{1F6D1} **Bot Stopped**`);
      lines.push("");
    }

    const report = getReport();
    const balIcon = report.totalProfitUsd >= 0 ? "\u{1F7E2}" : "\u{1F534}";  // Green/red based on PnL
    const winIcon = report.winRate >= 50 ? "\u{1F3C6}" : "\u{26A0}\uFE0F";   // Trophy/warning based on win rate

    // Performance summary
    lines.push(`\u{1F4CA} **Summary**`);
    lines.push(`\u{1F4CB} Total: \`${report.totalPositions}\``);
    lines.push(
      `\u{1F4CC} Open: \`${report.openPositions}\`` +
        (channelMode === "ave" ? ` / ${CONFIG.maxPositions}` : ""),  // Show max positions in ave mode
    );
    lines.push(`\u{2705} Closed: \`${report.closedPositions}\``);
    lines.push(
      `${winIcon} Wins: \`${report.winningTrades}\` / \`${report.losingTrades}\` (\`${report.winRate.toFixed(1)}%\`)`,
    );
    lines.push(
      `${balIcon} Total PnL: \`${report.totalProfitPct.toFixed(2)}%\` (\`$${report.totalProfitUsd.toFixed(2)}\`)`,
    );

    // Breakdown of close reasons (e.g. take_profit, stop_loss, expired)
    if (Object.keys(report.reasons).length > 0) {
      lines.push("");
      lines.push("**Close Reasons**");
      for (const [r, count] of Object.entries(report.reasons)) {
        lines.push(`  ${r}: \`${count}\``);
      }
    }

    await sendMessage(convert(lines.join("\n")));
  } catch { /* best-effort — shutdown notification is non-critical */ }
}

// ── Telegram Watchdog ───────────────────────────────────────────────────────

/**
 * Starts a periodic watchdog that checks Telegram client authorization.
 * If the client is not authorized or throws an error, the Telegram
 * listener is gracefully restarted.
 */
function startTelegramWatchdog(): void {  // Begins periodic health checks for Telegram connectivity
  // Create a timer that fires first after tgRetryDelayMs, then every 60 seconds
  _tgWatchdogSub = timer(CONFIG.tgRetryDelayMs, 60_000)
    .pipe(
      tap(async () => {  // Side-effect: run auth check on each tick
        if (_shuttingDown) return;  // Skip during active shutdown
        try {
          const client = getTelegramClient();  // Get the active MTProto client instance
          const ok = await client.checkAuthorization();  // Verify client is still authorized
          if (!ok) {  // Client lost authorization
            console.warn("[watchdog] Telegram not authorized — restarting");  // Log auth failure
            await restartTelegram();  // Reconnect Telegram listener
          }
        } catch (err) {  // Health check threw an unexpected error
          console.warn("[watchdog] Telegram health check failed — restarting:", err);  // Log error
          await restartTelegram();  // Attempt to recover by restarting
        }
      }),
    )
    .subscribe();  // Activate the watchdog subscription
}

/**
 * Gracefully restarts the Telegram listener: stops the current listener,
 * resets the client state, waits 2 seconds, then starts a fresh listener.
 */
async function restartTelegram(): Promise<void> {  // Full Telegram listener restart sequence
  try { await stopTelegramListener(); } catch { /* ok */ }  // Stop current listener (best-effort)
  resetTelegramClient();  // Clear client state to force fresh connection
  await new Promise((r) => setTimeout(r, 2000));  // Brief cooldown before reconnecting
  try { await startTelegramListener(); } catch (err) {  // Start a new listener session
    console.error("[watchdog] Telegram restart failed:", err);  // Log restart failure
  }
}

// ── Application Entry ───────────────────────────────────────────────────────

start().catch((err) => {  // Bootstrap the entire application
  console.error("[main] Startup failed:", err);  // Log startup failure
  process.exit(1);  // Exit with error code 1
});

/**
 * Gracefully shuts down the entire application: sends a stop notification,
 * tears down trading subsystems, unsubscribes from observables, stops
 * persistence and reporter, logs a performance report, and exits the process.
 */
async function shutdown(error?: string): Promise<void> {  // Graceful shutdown entry point (optional error context)
  if (_shuttingDown) return;  // Prevent re-entrant shutdown if already in progress
  _shuttingDown = true;        // Set flag to block concurrent shutdown calls

  console.log("\n[main] Shutting down...");  // Log shutdown initiation

  await sendStoppedMessage(error);  // Post shutdown/crash notification to Telegram with summary

  if (stopLiveTradingFn) {  // Check if live trading stop handle was registered
    try { stopLiveTradingFn(); } catch (err) {  // Tear down live mode subsystems
      console.error("[main] Live trading stop failed:", err);  // Log but continue shutdown
    }
  }

  if (stopSimTradingFn) {  // Check if simulator trading stop handle was registered
    try { stopSimTradingFn(); } catch (err) {  // Tear down simulator mode subsystems
      console.error("[main] Simulator trading stop failed:", err);  // Log but continue shutdown
    }
  }

  _tgWatchdogSub?.unsubscribe();  // Stop the periodic Telegram health check
  stopReporter();                  // Stop the Telegram bot reporter
  stopPersistence();               // Stop trade analytics persistence
  await stopTelegramListener().catch(() => {});  // Disconnect MTProto Telegram client (best-effort)

  const { getReport } = await import("./shared/trade_bridge");  // Dynamically import bridge to get final report
  const report = getReport();  // Generate final performance report for console output

  // Print a formatted performance summary to stdout
  console.log("=".repeat(50));
  console.log("PERFORMANCE REPORT");
  console.log("=".repeat(50));
  console.log(`Total positions : ${report.totalPositions}`);    // Total trade count
  console.log(`Open           : ${report.openPositions}`);      // Currently open positions
  console.log(`Closed         : ${report.closedPositions}`);    // Closed positions count
  console.log(`Wins           : ${report.winningTrades}`);      // Winning trade count
  console.log(`Losses         : ${report.losingTrades}`);       // Losing trade count
  console.log(`Win rate       : ${report.winRate.toFixed(1)}%`);  // Win percentage
  console.log(`Total PnL      : $${report.totalProfitUsd.toFixed(2)} (${report.totalProfitPct.toFixed(2)}%)`);  // Overall PnL
  console.log(`Avg PnL        : $${report.avgProfitUsd.toFixed(2)} (${report.avgProfitPct.toFixed(2)}%)`);  // Average PnL per trade
  console.log(`Best trade     : ${report.bestTradePct.toFixed(2)}%`);  // Best trade PnL
  console.log(`Worst trade    : ${report.worstTradePct.toFixed(2)}%`);  // Worst trade PnL
  console.log(`Close reasons  : ${JSON.stringify(report.reasons)}`);  // Breakdown of close reasons

  process.exit(error ? 1 : 0);  // Exit with code 1 if error, 0 otherwise
}

process.on("SIGINT", () => shutdown());   // Handle Ctrl+C gracefully
process.on("SIGTERM", () => shutdown());  // Handle termination signal gracefully
process.on("unhandledRejection", (reason) => {  // Catch unhandled promise rejections
  const msg = reason instanceof Error ? reason.message : String(reason);  // Extract error message
  console.error("[main] Unhandled rejection:", msg);  // Log the rejection
  shutdown(msg);  // Graceful shutdown with error context
});
process.on("uncaughtException", (err) => {  // Catch uncaught exceptions
  console.error("[main] Uncaught exception:", err.message);  // Log the exception
  shutdown(err.message);  // Graceful shutdown with error context
});
