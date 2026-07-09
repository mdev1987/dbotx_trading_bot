import {
  startTelegramListener,
  stopTelegramListener,
  acceptedSignal$,
  expiredPair$,
} from "./telegram/telegram_client";

import type { PerformanceReport } from "./dbotx/types";
import {
  connectDataWs,
  disconnectDataWs,
  priceUpdate$,
  subscribePair,
  unsubscribePair,
} from "./dbotx/dbotx_data_ws";
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

    console.table({
      Token: signal.Token,
      Pair: signal.LP,
      Contract: signal.CA,
      MarketCap: signal.marketCapUSD,
    });

    subscribePair(signal.LP!, signal.CA!);

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
  // Remove expired subscriptions
  //

  expiredPair$.subscribe((pairs) => {
    for (const pair of pairs) {
      unsubscribePair(pair);

      console.log(`[WS] Unsubscribed ${pair}`);
    }
  });

  //
  // Live market price
  //

  priceUpdate$.subscribe((price) => {
    console.log(`[PRICE] ${price.token}  $${price.priceUsd.toFixed(10)}`);

    reporter.sendMessage(
      [
        "📈 Price Update",
        "",
        `Token: ${price.token}`,
        `Price: $${price.priceUsd}`,
      ].join("\n"),
    );
  });

  //
  // Shutdown
  //

  process.on("SIGINT", async () => {
    console.log();
    console.log("Stopping...");

    disconnectDataWs();

    await stopTelegramListener();
    await reporter.sendMessage("🟥 Integration test stopped.");
    reporter.stop();

    process.exit(0);
  });

  console.log();
  console.log("Ready.");
}

main().catch(console.error);
