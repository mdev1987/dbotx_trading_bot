import { Subscription } from "rxjs";

import {
  startTelegramListener,
  stopTelegramListener,
  acceptedSignal$,
} from "./telegram/telegram_client";

import {
  connectDataWs,
  disconnectDataWs,
  subscribePairs,
  priceUpdate$ as dbotxPriceUpdate$,
} from "./data_stream/dbotx_data_stream";

import {
  connectPumpStream,
  disconnectPumpStream,
  pumpEvent$,
} from "./data_stream/pumpapi_data_stream";

import type { PerformanceReport } from "./data_stream/types";

import { TelegramReporter } from "./telegram/telegram_bot";
import { EMPTY } from "rxjs";

const subscriptions: Subscription[] = [];

async function main(): Promise<void> {
  console.clear();

  console.log("======================================");
  console.log(" DBotX Trade Bot");
  console.log("======================================");

  //
  // Reporter
  //

  const reporter = new TelegramReporter();

  reporter.wire({
    getReport: (): PerformanceReport => ({
      openPositions: 0,
      closedPositions: 0,
      totalPositions: 0,
      winningTrades: 0,
      losingTrades: 0,
      winRate: 0,
      totalProfitPct: 0,
      totalProfitUsd: 0,
      bestTradePct: 0,
      worstTradePct: 0,
      reasons: {},
      avgProfitPct: 0,
      avgProfitUsd: 0,
    }),

    getBalanceStr: () => "Test Mode",

    openPositions$: EMPTY,
    positionEvent$: EMPTY,
    positionClosed$: EMPTY,
  });

  reporter.start();

  //
  // DBotX Data Stream
  //

  // connectDataWs();

  //
  // PumpAPI Stream
  //

  connectPumpStream();

  //
  // Telegram MTProto
  //

  await startTelegramListener();

  reporter.sendMessage("🟢 Bot started.\nListening for trading signals...");

  //
  // New trading signal
  //

  subscriptions.push(
    acceptedSignal$.subscribe((signal) => {
      const token = signal.Token ?? "Unknown";
      const lpPair = signal.LP ?? "";
      const ca = signal.CA ?? "";
      const mcap = signal.marketCapUSD;

      console.log();
      console.log("==================================");
      console.log(`NEW SIGNAL: ${token}`);
      console.log("==================================");
      console.dir(signal, { depth: null, colors: true });

      //
      // Subscribe the LP pair to DBotX price stream
      //

      if (lpPair) {
        subscribePairs([lpPair]);
        console.log(`[Main] Subscribed pair ${lpPair} to DBotX data stream`);
      }

      //
      // Report to Telegram bot
      //

      reporter.sendMessage(
        [
          "🟢 New Signal",
          "",
          `Token: ${token}`,
          `CA: \`${ca}\``,
          `Pair: \`${lpPair}\``,
          mcap ? `Market Cap: $${mcap.toLocaleString()}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }),
  );

  //
  // Price tracking - DBotX
  //

  // subscriptions.push(
  //   dbotxPriceUpdate$.subscribe((price) => {
  //     console.log(
  //       `[Price] ${price.pair.slice(0, 8)} | $${price.priceUsd.toFixed(10)} | ${new Date(price.timestamp).toLocaleTimeString()}`,
  //     );
  //   }),
  // );

  //
  // Price tracking - PumpAPI
  //

  subscriptions.push(
    pumpEvent$.subscribe((event) => {
      console.log(
        `[PumpAPI] ${event.action.toUpperCase()} | ${event.mint.slice(0, 8)} | $${event.price}`,
      );
    }),
  );

  //
  // Shutdown
  //

  process.on("SIGINT", async () => {
    console.log();
    console.log("Stopping...");

    for (const sub of subscriptions) sub.unsubscribe();

    //disconnectDataWs();
    disconnectPumpStream();
    await stopTelegramListener();

    console.log("Bot stopped.");
    reporter.stop();

    process.exit(0);
  });

  console.log();
  console.log("Ready.");
}

main().catch(console.error);
