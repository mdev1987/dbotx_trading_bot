import { CONFIG } from "./config";

import { simulatorTrading } from "./trading/simulator/trading";
import { liveTrading } from "./trading/live/trading";
import { initLiveStore, recoverLivePositions, startLiveMonitor, stopLiveMonitor, connectTradeWs, disconnectTradeWs } from "./trading/live";

import { unifiedPriceUpdate$, initPriceEngine, stopPriceEngine } from "./data_stream/price_engine";
import { connectDataWs, disconnectDataWs } from "./data_stream/dbotx_data_stream";
import { connectPumpStream, disconnectPumpStream } from "./data_stream/pumpapi_data_stream";
import { updatePositionPrice } from "./strategy/positions_store";
import { registerStrategies, scanPositions } from "./strategy/scanner";
import { PositionEngine } from "./strategy/positions_engine";
import { StopLossStrategy } from "./strategy/exit-strategies/stop-loss";
import { TrailingStopStrategy } from "./strategy/exit-strategies/trailing-stop";
import { PartialTakeProfitStrategy } from "./strategy/exit-strategies/partial-tp";
import { TtlStrategy } from "./strategy/exit-strategies/ttl";
import { startTelegramListener, stopTelegramListener } from "./telegram/telegram_client";
import { initTelegramBot, shutdownTelegramBot } from "./telegram/telegram_bot";
import { startTrading, stopTrading } from "./trading/handler";

/* -------------------------------------------------------------------------- */
/*                          Strategy Engine Wiring                            */
/* -------------------------------------------------------------------------- */

if (!CONFIG.liveMode) {
  registerStrategies([
    new StopLossStrategy(CONFIG.stopLossEnabled, CONFIG.stopLossPct),
    new TrailingStopStrategy(CONFIG.trailingActivationPct, CONFIG.trailingDistancePct),
    new PartialTakeProfitStrategy(CONFIG.partialTpEnabled, CONFIG.partialTpTiers),
    new TtlStrategy(CONFIG.baseTtlSecs, CONFIG.maxTtlSecs, CONFIG.minProfitForTtlExtensionPct),
  ]);
}

const positionEngine = new PositionEngine(
  unifiedPriceUpdate$,
  updatePositionPrice,
  scanPositions,
);

const services = {
  async start(): Promise<void> {
    initTelegramBot();
    connectDataWs();
    connectPumpStream();
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

    startTelegramListener().catch((err) =>
      console.error("[Main] Telegram listener failed:", err),
    );

    console.log("[Main] All services started");
  },

  stop(): void {
    if (CONFIG.liveMode) {
      stopLiveMonitor();
      disconnectTradeWs();
    }
    stopTrading();
    positionEngine.stop();
    stopPriceEngine();
    disconnectDataWs();
    disconnectPumpStream();
    stopTelegramListener();
    shutdownTelegramBot();
    console.log("[Main] All services stopped");
  },
};

services.start().catch((err) => {
  console.error("[Main] Startup failed:", err);
  process.exit(1);
});
