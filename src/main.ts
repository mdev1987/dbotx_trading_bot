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
import { initBridge } from "./shared/trade_bridge";
import type { BridgeConfig } from "./shared/trade_bridge";

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

let stopLiveTradingFn: (() => void) | undefined;

async function start(): Promise<void> {
  // Step 1: Connect to Telegram and begin listening for trade signals.
  try {
    await startTelegramListener();
  } catch (err) {
    console.error("[main] Telegram listener failed to start:", err);
  }

  // Step 2: Start the position manager (simulator or live) and capture events.
  let bridgeConfig: BridgeConfig;

  if (CONFIG.liveMode) {
    bridgeConfig = await startLiveMode();
  } else {
    bridgeConfig = await startSimulatorMode();
  }

  // Step 3: Wire the bridge so reporter & persistence read from the active mode.
  initBridge(bridgeConfig);

  // Step 4: Start persisting position lifecycle events.
  startPersistence();

  // Step 5: Start the Telegram bot reporter.
  startReporter();

  // Step 6: Start Telegram health check watchdog.
  startTelegramWatchdog();

  // Step 7: Send the startup notification.
  await sendStartedMessage();
}

async function startSimulatorMode(): Promise<BridgeConfig> {
  console.log("[main] Starting simulator mode...");

  const simModule = await import("./simulator/position_manager");

  const { simulatorAccount$, latestAccount } = await import("./simulator/account");
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

  const { generateReport } = await import("./analytics/reports");

  return {
    positionEvent$: simModule.positionEvent$,
    positionClosed$: simModule.positionClosed$,
    openPositions$: simModule.openPositions$,
    getReport: generateReport,
    getBalanceStr: () => {
      if (latestAccount) {
        const change = latestAccount.changeAll;
        const icon = change >= 0 ? "\u{1F7E2}" : "\u{1F534}";
        const sign = change >= 0 ? "+" : "";
        return `${icon} \u{1F4B0} Balance: \`$${latestAccount.balance.toFixed(2)}\` (\`${sign}${(change * 100).toFixed(2)}%\`)`;
      }
      return "";
    },
  };
}

async function startLiveMode(): Promise<BridgeConfig> {
  console.log("[main] Starting live mode...");

  const liveModule = await import("./live/position_manager");
  stopLiveTradingFn = liveModule.stopLiveTrading;

  await liveModule.startLiveTrading();

  const wallet = await import("./live/wallet");

  return {
    positionEvent$: liveModule.positionEvent$,
    positionClosed$: liveModule.positionClosed$,
    openPositions$: liveModule.openPositions$,
    getReport: () => {
      const openCount = liveModule.countOpenPositions();
      return {
        totalPositions: 0,
        closedPositions: 0,
        openPositions: openCount,
        winningTrades: 0,
        losingTrades: 0,
        winRate: 0,
        totalProfitUsd: 0,
        totalProfitPct: 0,
        avgProfitPct: 0,
        avgProfitUsd: 0,
        bestTradePct: 0,
        worstTradePct: 0,
        reasons: {},
      };
    },
    getBalanceStr: () => {
      if (wallet.latestBalance) {
        return `\u{1F4B0} Balance: \`${wallet.latestBalance.balanceSol.toFixed(2)} SOL\``;
      }
      return "";
    },
  };
}

function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function startedMessage(): string {
  const modeLabel = CONFIG.liveMode ? "Live" : "Simulate";
  const modeIcon = CONFIG.liveMode ? "\u{1F4E1}" : "\u{1F9EA}";

  const lines: string[] = [
    `\u{1F680} **Bot Started**`,
    "",
    `Mode: ${modeIcon} \`${modeLabel}\``,
  ];

  if (CONFIG.liveMode) {
    lines.push(`\u{1F512} Wallet: \`${process.env.LIVE_WALLET_ID ?? "?"}\``);
    const buyEnabled = (process.env.LIVE_BUY_ENABLED ?? "true").toLowerCase() === "true";
    lines.push(`\u{1F6E1}\uFE0F Buy: \`${buyEnabled ? "ENABLED" : "PAPER (disabled)"}\``);
  }

  lines.push(`\u{1F4CC} Max Positions: \`${CONFIG.maxPositions}\``);

  lines.push(
    `\u{1F4B0} Position: \`${CONFIG.positionSize.toFixed(2)} SOL\` ` +
      `(min \`${CONFIG.minPositionSol.toFixed(2)}\` / ` +
      `max \`${CONFIG.maxPositionSol.toFixed(2)}\` ` +
      `risk \u{2264}\`${CONFIG.maxRiskPct.toFixed(1)}%\` of balance)`,
  );

  if (channel_mode === "ave") {
    lines.push(
      `\u{23F0} Base TTL: \`${fmtDuration(CONFIG.baseTtlSecs)}\`` +
        (CONFIG.minProfitForTtlExtensionPct > 0
          ? ` \u{1F504} renew \u{2265}\`${(CONFIG.minProfitForTtlExtensionPct * 100).toFixed(1)}%\``
          : "") +
        ` | Max: \`${fmtDuration(CONFIG.maxTtlSecs)}\``,
    );
  }

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
    lines.push(
      `\u{1F7E1} Trailing: \`${(CONFIG.trailingActivationPct * 100).toFixed(0)}%\` activation, ` +
        `\`${(CONFIG.trailingDistancePct * 100).toFixed(0)}%\` distance`,
    );
  }

  return convert(lines.join("\n"));
}

async function sendStartedMessage(): Promise<void> {
  try {
    await sendMessage(startedMessage());
  } catch { /* best-effort */ }
}

async function sendStoppedMessage(error?: string): Promise<void> {
  try {
    const { getReport } = await import("./shared/trade_bridge");

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

    const report = getReport();
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

async function shutdown(error?: string): Promise<void> {
  if (_shuttingDown) return;
  _shuttingDown = true;

  console.log("\n[main] Shutting down...");

  await sendStoppedMessage(error);

  if (stopLiveTradingFn) {
    try {
      stopLiveTradingFn();
    } catch (err) {
      console.error("[main] Live trading stop failed:", err);
    }
  }

  _tgWatchdogSub?.unsubscribe();

  stopReporter();
  stopPersistence();
  await stopTelegramListener().catch(() => {});

  const { getReport } = await import("./shared/trade_bridge");
  const report = getReport();
  console.log("=".repeat(50));
  console.log("PERFORMANCE REPORT");
  console.log("=".repeat(50));
  console.log(`Total positions : ${report.totalPositions}`);
  console.log(`Open           : ${report.openPositions}`);
  console.log(`Closed         : ${report.closedPositions}`);
  console.log(`Wins           : ${report.winningTrades}`);
  console.log(`Losses         : ${report.losingTrades}`);
  console.log(`Win rate       : ${report.winRate.toFixed(1)}%`);
  console.log(`Total PnL      : $${report.totalProfitUsd.toFixed(2)} (${report.totalProfitPct.toFixed(2)}%)`);
  console.log(`Avg PnL        : $${report.avgProfitUsd.toFixed(2)} (${report.avgProfitPct.toFixed(2)}%)`);
  console.log(`Best trade     : ${report.bestTradePct.toFixed(2)}%`);
  console.log(`Worst trade    : ${report.worstTradePct.toFixed(2)}%`);
  console.log(`Close reasons  : ${JSON.stringify(report.reasons)}`);

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
