import { CONFIG } from "./config";

import { simulatorTrading } from "./trading/simulator/trading";
import { liveTrading } from "./trading/live/trading";
import { initLiveStore } from "./trading/live/store";
import { recoverLivePositions } from "./trading/live/recovery";
import { connectTradeWs, disconnectTradeWs, startLiveMonitor, stopLiveMonitor } from "./trading/live/trade-ws";

import {
  unifiedPriceUpdate$,
  initPriceEngine,
  stopPriceEngine,
} from "./data_stream/price_engine";
import {
  connectDataWs,
  disconnectDataWs,
} from "./data_stream/dbotx_data_stream";
import {
  connectPumpStream,
  disconnectPumpStream,
} from "./data_stream/pumpapi_data_stream";
import { updatePositionPrice } from "./strategy/positions_store";
import { registerStrategies, scanPositions } from "./strategy/scanner";
import { PositionEngine } from "./strategy/positions_engine";
import { StopLossStrategy } from "./strategy/exit-strategies/stop-loss";
import { TrailingStopStrategy } from "./strategy/exit-strategies/trailing-stop";
import { PartialTakeProfitStrategy } from "./strategy/exit-strategies/partial-tp";
import { TtlStrategy } from "./strategy/exit-strategies/ttl";
import {
  startTelegramListener,
  stopTelegramListener,
} from "./telegram/telegram_client";
import { initTelegramBot, shutdownTelegramBot } from "./telegram/telegram_bot";
import {
  initSignalQueue,
  stopSignalQueue,
} from "./telegram/telegram_signal_queue";
import { startTrading, stopTrading } from "./trading/handler";

/* -------------------------------------------------------------------------- */
/*                          Strategy Engine Wiring                            */
/* -------------------------------------------------------------------------- */

if (!CONFIG.liveMode) {
  registerStrategies([
    new StopLossStrategy(CONFIG.stopLossEnabled, CONFIG.stopLossPct / 100),
    new TrailingStopStrategy(
      CONFIG.trailingActivationPct / 100,
      CONFIG.trailingDistancePct / 100,
    ),
    new PartialTakeProfitStrategy(
      CONFIG.partialTpEnabled,
      CONFIG.partialTpTiers,
    ),
  ]);
}

registerStrategies([
  new TtlStrategy(
    CONFIG.baseTtlSecs,
    CONFIG.maxTtlSecs,
    CONFIG.profitPercentChange / 100,
  ),
]);

const positionEngine = new PositionEngine(
  unifiedPriceUpdate$,
  updatePositionPrice,
  scanPositions,
);

const services = {
  async start(): Promise<void> {
    initTelegramBot();
    connectDataWs();
    // connectPumpStream();   // Uncomment this line if you want to enable pumpapi data stream
    initPriceEngine();

    if (CONFIG.liveMode) {
      initLiveStore(CONFIG.liveDbPath);

      if (CONFIG.recoveryOnStart) {
        await recoverLivePositions();
      }

      connectTradeWs();
      startLiveMonitor();
    }

    positionEngine.start();
    await startTrading(CONFIG.liveMode ? liveTrading : simulatorTrading);

    startTelegramListener()
      .then(() => {
        initSignalQueue(CONFIG.telegramChannelUserName);
      })
      .catch((err) => console.error("[Main] Telegram listener failed:", err));

    console.log("[Main] All services started");
  },

  stop(): void {
    if (CONFIG.liveMode) {
      stopLiveMonitor();
      disconnectTradeWs();
    }
    stopTrading();
    stopSignalQueue();
    positionEngine.stop();
    stopPriceEngine();
    disconnectDataWs();
    // disconnectPumpStream(); // Uncomment this line if you want to disable pumpapi data stream
    stopTelegramListener();
    shutdownTelegramBot();
    console.log("[Main] All services stopped");
  },
};

services
  .start()
  .then(() => {
    process.on("SIGINT", () => {
      console.log("\n[Main] SIGINT received");
      services.stop();
      process.exit(0);
    });

    process.on("SIGTERM", () => {
      console.log("[Main] SIGTERM received");
      services.stop();
      process.exit(0);
    });
  })
  .catch((err) => {
    console.error("[Main] Startup failed:", err);
    services.stop();
    process.exit(1);
  });
