import { Subscription, timer, from } from "rxjs";
import { mergeMap, filter } from "rxjs/operators";

import { CONFIG } from "./config";

import {
  startTelegramListener,
  stopTelegramListener,
  acceptedSignal$,
} from "./telegram/telegram_client";

import type { TradingApi } from "./strategy/api";
import { simulatorApi } from "./simulator/api";
import { liveApi } from "./live/api";

import {
  connectPumpStream,
  disconnectPumpStream,
} from "./data_stream/pumpapi_data_stream";

import {
  connectDataWs,
  disconnectDataWs,
} from "./data_stream/dbotx_data_stream";

import {
  initPriceEngine,
  stopPriceEngine,
  unifiedPriceUpdate$,
  trackToken,
  untrackToken,
} from "./data_stream/price_engine";

import {
  openPosition,
  handlePriceUpdate,
  checkExpiredPositions,
  cleanupExpiredSignals,
  refreshAccountInfo,
  getReport,
  getBalanceStr,
  openPositions$,
  positionEvent$,
  positionClosed$,
} from "./strategy/position";

import { TelegramReporter } from "./telegram/telegram_bot";

const api: TradingApi = CONFIG.liveMode ? liveApi : simulatorApi;

const subscriptions: Subscription[] = [];
let startedAt = 0;

function fmtDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const hrs = Math.floor(mins / 60);
  if (hrs > 0) return `${hrs}h ${mins % 60}m ${secs % 60}s`;
  if (mins > 0) return `${mins}m ${secs % 60}s`;
  return `${secs}s`;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

async function main(): Promise<void> {
  console.clear();

  const mode = CONFIG.liveMode ? "LIVE" : "SIMULATOR";
  console.log("======================================");
  console.log(` DBotX Trade Bot [${mode}]`);
  console.log("======================================");

  //
  // Reporter
  //

  const reporter = new TelegramReporter();

  reporter.wire({
    getReport,
    getBalanceStr,
    openPositions$,
    positionEvent$,
    positionClosed$,
  });

  reporter.start();

  //
  // Price Sources
  //

  connectPumpStream();
  connectDataWs();
  initPriceEngine();

  //
  // Telegram MTProto
  //

  await startTelegramListener();

  const modeIcon = CONFIG.liveMode ? "📡" : "🧪";
  const startLines = [
    `**${modeIcon} Bot Started**`,
    `━━━━━━━━━━━━━━━━━━━`,
    `📶 Mode: \`${mode}\``,
    `🕐 Time: \`${fmtTime(Date.now())}\``,
    `━━━━━━━━━━━━━━━━━━━`,
    `👂 Listening for trading signals...`,
  ];
  reporter.sendMessage(startLines.join("\n"));

  startedAt = Date.now();

  //
  // New trading signal -> buy or queue
  //

  const MAX_CONCURRENT_BUYS = Math.min(CONFIG.maxPositions, 3);

  subscriptions.push(
    acceptedSignal$
      .pipe(
        mergeMap(
          (signal) =>
            from(
              (async () => {
                console.log();
                console.log("==================================");
                console.log(`NEW SIGNAL: ${signal.Token}`);
                console.log("==================================");
                console.dir(signal, { depth: null, colors: true });
                await openPosition(api, signal);
              })(),
            ),
          MAX_CONCURRENT_BUYS,
        ),
      )
      .subscribe(),
  );

  //
  // Unified price tracking (DBotX WS + PumpAPI + DexScreener)
  //

  subscriptions.push(
    unifiedPriceUpdate$
      .pipe(
        mergeMap((update) =>
          from(
            (async () => {
              await handlePriceUpdate(api, update);
            })(),
          ),
        ),
      )
      .subscribe(),
  );

  //
  // Track/untrack tokens on position events
  //

  subscriptions.push(
    positionEvent$
      .pipe(filter((ev) => ev.type === "opened"))
      .subscribe((ev) => {
        trackToken(ev.position.token, ev.position.pair);
      }),
  );

  subscriptions.push(
    positionEvent$
      .pipe(filter((ev) => ev.type === "closed"))
      .subscribe((ev) => {
        untrackToken(ev.position.token);
      }),
  );

  //
  // Periodic account info
  //

  subscriptions.push(
    timer(CONFIG.accountPollIntervalMs, CONFIG.accountPollIntervalMs).subscribe(
      async () => {
        const account = await refreshAccountInfo(api);
        const balUnit = CONFIG.liveMode ? "SOL" : "$";
        console.log(
          `[Account] Balance: ${balUnit}${account.balance.toFixed(2)} | Change: ${(account.change24h * 100).toFixed(2)}% | Holdings: ${account.holdTokens}`,
        );
      },
    ),
  );

  //
  // Periodic TTL check for positions
  //

  subscriptions.push(
    timer(CONFIG.expiryCheckMs, CONFIG.expiryCheckMs).subscribe(async () => {
      await checkExpiredPositions(api);
    }),
  );

  //
  // Periodic signal queue cleanup
  //

  subscriptions.push(
    timer(
      CONFIG.signalCleanupIntervalMs,
      CONFIG.signalCleanupIntervalMs,
    ).subscribe(() => {
      cleanupExpiredSignals();
    }),
  );

  //
  // Shutdown
  //

  process.on("SIGINT", async () => {
    console.log();
    console.log("Stopping...");

    for (const sub of subscriptions) sub.unsubscribe();

    const report = getReport();
    const uptime = Date.now() - startedAt;

    const stopLines = [
      `🛑 **Bot Stopped**`,
      `━━━━━━━━━━━━━━━━━━━`,
      `📶 Mode: \`${mode}\``,
      `⏱ Uptime: \`${fmtDuration(uptime)}\``,
      `━━━━━━━━━━━━━━━━━━━`,
      report.openPositions > 0 || report.closedPositions > 0
        ? `📊 **Session Summary**`
        : "",
      report.openPositions > 0 || report.closedPositions > 0
        ? `📌 Open: \`${report.openPositions}\`  |  ✅ Closed: \`${report.closedPositions}\``
        : "",
      report.closedPositions > 0
        ? `🎯 Win Rate: \`${report.winRate.toFixed(1)}%\`  |  💰 PnL: \`${(report.totalProfitPct * 100).toFixed(2)}%\``
        : "",
      `━━━━━━━━━━━━━━━━━━━`,
      `👋 Goodbye!`,
    ].filter(Boolean);

    reporter.sendMessage(stopLines.join("\n"));

    stopPriceEngine();
    disconnectPumpStream();
    disconnectDataWs();
    await stopTelegramListener();

    await reporter.stop();

    console.log("Bot stopped.");

    process.exit(0);
  });

  console.log();
  console.log(`Ready. [${mode}]`);
}

main().catch(console.error);
