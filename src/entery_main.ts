import { CONFIG } from "./config";
import {
  startTelegramListener, stopTelegramListener, resetTelegramClient,
  startReporter, stopReporter, sendMessage,
  getTelegramClient, reporter,
} from "./telegram";
import { startBot, recoverOpenPositions, getReport } from "./bot";
import { connectTradeResultsWs, disconnectTradeResultsWs } from "./dbotx";
import { timer, Subscription } from "rxjs";
import { tap } from "rxjs/operators";
import { convert } from "telegram-markdown-v2";

function maskAddress(addr: string, prefixLen = 6, suffixLen = 4): string {
  if (addr.length <= prefixLen + suffixLen + 3) return addr;
  return `${addr.slice(0, prefixLen)}...${addr.slice(-suffixLen)}`;
}

function maskWalletId(id: string | number): string {
  return maskAddress(String(id), 4, 4);
}

let _shuttingDown = false;
let _tgWatchdogSub: Subscription | undefined;

async function start(): Promise<void> {
  try {
    await startTelegramListener();
  } catch (err) {
    console.error("[main] Telegram listener failed to start:", err);
  }

  startBot();

  try {
    await recoverOpenPositions();
  } catch (err) {
    console.error("[main] Recovery failed:", err);
  }

  startReporter();
  connectTradeResultsWs();
  startTelegramWatchdog();

  await sendStartedMessage();
}

// ── Message Formatting ────────────────────────────────────────────────────

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
    lines.push(`\u{1F512} Wallet: \`${maskWalletId(CONFIG.walletId || "?")}\``);
    lines.push(`\u{1F6E1}\uFE0F Buy: \`${CONFIG.liveBuyEnabled ? "ENABLED" : "PAPER (disabled)"}\``);
  }

  lines.push(`\u{1F4CC} Max Positions: \`${CONFIG.maxPositions}\``);
  lines.push(
    `\u{1F4B0} Position: \`${CONFIG.positionSize.toFixed(2)} SOL\` ` +
    `(min \`${CONFIG.minPositionSol.toFixed(2)}\` / ` +
    `max \`${CONFIG.maxPositionSol.toFixed(2)}\` ` +
    `risk \u{2264}\`${CONFIG.maxRiskPct.toFixed(1)}%\` of balance)`,
  );

  const channelMode = CONFIG.telegramChannelUserName;
  if (channelMode === "avesolanatokenscanner" || channelMode === "avesignalmonitor") {
    lines.push(
      `\u{23F0} Base TTL: \`${fmtDuration(CONFIG.baseTtlSecs)}\`` +
      (CONFIG.minProfitForTtlExtensionPct > 0
        ? ` \u{1F504} renew \u{2265}\`${(CONFIG.minProfitForTtlExtensionPct * 100).toFixed(1)}%\``
        : "") +
      ` | Max: \`${fmtDuration(CONFIG.maxTtlSecs)}\``,
    );
  }

  lines.push("", "**Exit Settings**");

  if (channelMode === "avesignalmonitor") {
    lines.push(`\u{1F7E2} TP: \`from signal maxPumpX\``);
  }
  if (CONFIG.stopLossPct) {
    lines.push(`\u{1F534} Stop Loss: \`${(CONFIG.stopLossPct * 100).toFixed(1)}%\``);
  }
  if (CONFIG.partialTpTiers.length > 0) {
    const tiers = CONFIG.partialTpTiers.map((t) => `${(t.pct * 100).toFixed(0)}%@${(t.at * 100).toFixed(0)}%`).join(", ");
    lines.push(`\u{1F7E2} Partial TP: \`${tiers}\``);
  }
  if (CONFIG.backstopTpPct) {
    lines.push(`\u{1F7E2} Backstop TP: \`${(CONFIG.backstopTpPct * 100).toFixed(0)}%\``);
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
  try { await sendMessage(startedMessage()); } catch { /* best-effort */ }
}

async function sendStoppedMessage(error?: string): Promise<void> {
  try {
    const lines: string[] = [];
    if (error) {
      lines.push(`\u{1F4A5} **Bot Crashed**`, "", `Error: \`${error}\``, "");
    } else {
      lines.push(`\u{1F6D1} **Bot Stopped**`, "");
    }
    const report = getReport();
    const balIcon = report.totalProfitUsd >= 0 ? "\u{1F7E2}" : "\u{1F534}";
    lines.push(`\u{1F4CA} **Summary**`);
    lines.push(`\u{1F4CB} Total: \`${report.totalPositions}\``);
    lines.push(`\u{1F4CC} Open: \`${report.openPositions}\``);
    lines.push(`\u{2705} Closed: \`${report.closedPositions}\``);
    lines.push(
      `\u{1F3C6} Wins: \`${report.winningTrades}\` / \`${report.losingTrades}\` (\`${report.winRate.toFixed(1)}%\`)`,
    );
    lines.push(
      `${balIcon} Total PnL: \`${report.totalProfitPct.toFixed(2)}%\` (\`$${report.totalProfitUsd.toFixed(2)}\`)`,
    );
    if (Object.keys(report.reasons).length > 0) {
      lines.push("", "**Close Reasons**");
      for (const [r, count] of Object.entries(report.reasons)) {
        lines.push(`  ${r}: \`${count}\``);
      }
    }
    await sendMessage(convert(lines.join("\n")));
  } catch { /* best-effort */ }
}

// ── Telegram Watchdog ──────────────────────────────────────────────────────

function startTelegramWatchdog(): void {
  _tgWatchdogSub = timer(CONFIG.tgRetryDelayMs, 60_000).pipe(
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
  ).subscribe();
}

async function restartTelegram(): Promise<void> {
  try { await stopTelegramListener(); } catch { /* ok */ }
  resetTelegramClient();
  await new Promise((r) => setTimeout(r, 2000));
  try { await startTelegramListener(); } catch (err) {
    console.error("[watchdog] Telegram restart failed:", err);
  }
}

// ── Shutdown ───────────────────────────────────────────────────────────────

async function shutdown(error?: string): Promise<void> {
  if (_shuttingDown) return;
  _shuttingDown = true;

  console.log("\n[main] Shutting down...");
  await sendStoppedMessage(error);

  _tgWatchdogSub?.unsubscribe();
  stopReporter();
  disconnectTradeResultsWs();
  await stopTelegramListener().catch(() => {});

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

  process.exit(error ? 1 : 0);
}

// ── Bootstrap ──────────────────────────────────────────────────────────────

start().catch((err) => {
  console.error("[main] Startup failed:", err);
  process.exit(1);
});

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
