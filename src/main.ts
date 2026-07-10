import {
  startTelegramListener,
  stopTelegramListener,
  acceptedSignal$,
} from "./telegram/telegram_client";

import {
  connectDataWs,
  disconnectDataWs,
  priceUpdate$,
} from "./dbotx/dbotx_data_ws";
import type { PerformanceReport } from "./dbotx/types";

import { TelegramReporter } from "./telegram/telegram_bot";
import { EMPTY } from "rxjs";

async function main(): Promise<void> {
  console.clear();

  console.log("======================================");
  console.log(" DBotX Data Integration Test");
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
  // DBotX Market Data
  //

  connectDataWs();

  //
  // Telegram MTProto
  //

  await startTelegramListener();

  reporter.sendMessage(
    "🟢 Integration test started.\nListening for trading signals...",
  );

  //
  // New trading signal
  //

  acceptedSignal$.subscribe((signal) => {
    console.log();
    console.log("==================================");
    console.log("NEW SIGNAL");
    console.log("==================================");

    console.dir(signal, { depth: null, colors: true });

    reporter.sendMessage(
      [
        "🟢 New Signal",
        "",
        `Token: ${signal.Token}`,
        `Pair: ${signal.LP}`,
        `Contract: ${signal.CA}`,
        `Market Cap: $${signal.marketCapUSD}`,
      ].join("\n"),
    );
  });

  //
  // Live market price
  //

  priceUpdate$.subscribe((price) => {
    console.dir(price, { depth: null, colors: true });
  });

  //
  // Shutdown
  //

  process.on("SIGINT", async () => {
    console.log();
    console.log("Stopping...");

    disconnectDataWs();

    await stopTelegramListener();

    console.log("Integration test stopped.");
    reporter.stop();

    process.exit(0);
  });

  console.log();
  console.log("Ready.");
}

main().catch(console.error);
