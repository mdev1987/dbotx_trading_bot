import { Subscription, timer } from "rxjs";

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
  pumpEvent$,
} from "./data_stream/pumpapi_data_stream";

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
  // PumpAPI Stream (primary price source)
  //

  connectPumpStream();

  //
  // Telegram MTProto
  //

  await startTelegramListener();

  reporter.sendMessage(
    `🟢 Bot started [${mode}].\nListening for trading signals...`,
  );

  //
  // New trading signal -> buy or queue
  //

  subscriptions.push(
    acceptedSignal$.subscribe(async (signal) => {
      console.log();
      console.log("==================================");
      console.log(`NEW SIGNAL: ${signal.Token}`);
      console.log("==================================");
      console.dir(signal, { depth: null, colors: true });

      await openPosition(api, signal);
    }),
  );

  //
  // PumpAPI price tracking
  //

  subscriptions.push(
    pumpEvent$.subscribe(async (event) => {
      await handlePriceUpdate(api, event);

      const price = parseFloat(event.price);
      if (Number.isFinite(price) && price > 0) {
        console.log(
          `[Price] ${event.action.toUpperCase()} | ${event.mint.slice(0, 8)} | $${price.toFixed(10)}`,
        );
      }
    }),
  );

  //
  // Periodic account info
  //

  subscriptions.push(
    timer(CONFIG.accountPollIntervalMs, CONFIG.accountPollIntervalMs).subscribe(
      async () => {
        const account = await refreshAccountInfo(api);
        console.log(
          `[Account] Balance: ${account.balance.toFixed(2)} SOL | Change: ${(account.change24h * 100).toFixed(2)}% | Holdings: ${account.holdTokens}`,
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
    timer(CONFIG.signalCleanupIntervalMs, CONFIG.signalCleanupIntervalMs).subscribe(() => {
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

    disconnectPumpStream();
    await stopTelegramListener();

    console.log("Bot stopped.");
    reporter.stop();

    process.exit(0);
  });

  console.log();
  console.log(`Ready. [${mode}]`);
}

main().catch(console.error);
