/**
 * main.ts
 *
 * Application entry point.  Initialises persistence, the Telegram
 * reporter, the Telegram listener (teleproto), and the simulator
 * position manager.  Sends start / stop / crash notifications to
 * the configured Telegram chat.
 */

import "./simulator/position_manager";
import { startPersistence, stopPersistence } from "./analytics/trades_repository";
import { startReporter, stopReporter, sendMessage } from "./telegram/telegram_bot_reporter";
import { startTelegramListener, stopTelegramListener } from "./telegram/telegram_listener";
import { simulatorAccount$ } from "./simulator/account";
import { CONFIG } from "./config";
import { convert } from "telegram-markdown-v2";
import { tap } from "rxjs";

/* ------------------------------------------------------------------ */
/*  Startup                                                           */
/* ------------------------------------------------------------------ */

async function start(): Promise<void> {
  startPersistence();
  startReporter();

  try {
    await startTelegramListener();
  } catch (err) {
    /* Telegram listener is optional — the bot can still run without it */
    console.error("[main] Telegram listener failed to start:", err);
  }

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

  await sendStartedMessage();
}

function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function startedMessage(): string {
  const lines: string[] = [
    "\u{1F680} **Bot Started**",
    "",
    `Mode: \u{1F9EA} \`Simulate\``,
    `\u{1F4CC} Max Positions: \`${CONFIG.maxPositions}\``,
    `\u{1F4B0} Position Size: \`${CONFIG.positionSize.toFixed(2)} SOL\``,
    `\u{23F0} Position TTL: \`${fmtDuration(CONFIG.ttlPositionSeconds)}\``,
    "",
    "**Exit Settings**",
  ];

  if (CONFIG.stopLossPct) {
    lines.push(`\u{1F534} Stop Loss: \`${(CONFIG.stopLossPct * 100).toFixed(1)}%\``);
  }
  if (CONFIG.partialTpTiers.length > 0) {
    const tiers = CONFIG.partialTpTiers
      .map((t) => `${(t.pct * 100).toFixed(0)}%@${(t.at * 100).toFixed(0)}%`)
      .join(", ");
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
  if (CONFIG.ttlRenewalProfitPct > 0) {
    lines.push(
      `\u{1F504} TTL Renewal: \`${(CONFIG.ttlRenewalProfitPct * 100).toFixed(0)}%\` profit threshold`,
    );
  }
  if (CONFIG.signalQueueSize > 0) {
    lines.push(`\u{1F4E6} Signal Queue: \`${CONFIG.signalQueueSize}\` slots`);
  }

  return convert(lines.join("\n"));
}

async function sendStartedMessage(): Promise<void> {
  try {
    await sendMessage(startedMessage());
  } catch {
    /* Best-effort */
  }
}

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
    lines.push(`\u{1F4CC} Open: \`${report.openPositions} / ${CONFIG.maxPositions}\``);
    lines.push(`\u{2705} Closed: \`${report.closedPositions}\``);
    lines.push(`${winIcon} Wins: \`${report.winningTrades}\` / \`${report.losingTrades}\` (\`${report.winRate.toFixed(1)}%\`)`);
    lines.push(`${balIcon} Total PnL: \`${report.totalProfitPct.toFixed(2)}%\` (\`$${report.totalProfitUsd.toFixed(2)}\`)`);

    if (Object.keys(report.reasons).length > 0) {
      lines.push("");
      lines.push("**Close Reasons**");
      for (const [r, count] of Object.entries(report.reasons)) {
        lines.push(`  ${r}: \`${count}\``);
      }
    }

    await sendMessage(convert(lines.join("\n")));
  } catch {
    /* Best-effort */
  }
}

/* ------------------------------------------------------------------ */
/*  Run                                                               */
/* ------------------------------------------------------------------ */

start().catch((err) => {
  console.error("[main] Startup failed:", err);
  process.exit(1);
});

/* ------------------------------------------------------------------ */
/*  Graceful shutdown                                                 */
/* ------------------------------------------------------------------ */

let _shuttingDown = false;

async function shutdown(error?: string): Promise<void> {
  if (_shuttingDown) return;
  _shuttingDown = true;

  console.log("\n[main] Shutting down...");

  await sendStoppedMessage(error);

  stopReporter();
  stopPersistence();
  await stopTelegramListener().catch(() => {});

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
