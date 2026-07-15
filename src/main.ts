import { CONFIG } from "./config";

import { dbotxSimulateTrading } from "./trading/dbotx_trading/simulate/trading";
import { dbotxLiveTrading } from "./trading/dbotx_trading/live/trading";
import { refreshLiveBalance as refreshDbotxBalance } from "./trading/dbotx_trading/live/account";
import { initLiveStore as initDbotxStore } from "./trading/dbotx_trading/live/store";
import { recoverLivePositions as recoverDbotxPositions } from "./trading/dbotx_trading/live/recovery";
import { connectTradeWs as connectDbotxTradeWs, disconnectTradeWs as disconnectDbotxTradeWs, startLiveMonitor as startDbotxMonitor, stopLiveMonitor as stopDbotxMonitor } from "./trading/dbotx_trading/live/trade-ws";

import { pumpapiLiveTrading } from "./trading/pumpapi_trading/live/trading";
import { refreshPumpBalance } from "./trading/pumpapi_trading/live/account";
import { pumpapiPaperTrading, initPaperTrading } from "./trading/pumpapi_trading/paper/trading";

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

const isDbotx = CONFIG.tradingEngine === "dbotx";

if (!CONFIG.liveMode) {
  registerStrategies([
    new StopLossStrategy(CONFIG.stopLossEnabled, CONFIG.stopLossPct),
    new TrailingStopStrategy(
      CONFIG.trailingActivationPct,
      CONFIG.trailingDistancePct,
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
    CONFIG.profitPercentChange,
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
    initPriceEngine();

    if (CONFIG.liveMode) {
      if (isDbotx) {
        initDbotxStore(CONFIG.liveDbPath);

        if (CONFIG.recoveryOnStart) {
          await recoverDbotxPositions();
        }

        connectDbotxTradeWs();
        startDbotxMonitor();
      }
    } else {
      if (!isDbotx) {
        initPaperTrading();
      }
    }

    positionEngine.start();

    const tradingImpl = CONFIG.liveMode
      ? (isDbotx ? dbotxLiveTrading : pumpapiLiveTrading)
      : (isDbotx ? dbotxSimulateTrading : pumpapiPaperTrading);

    await startTrading(tradingImpl);

    if (CONFIG.liveMode) {
      const refreshBalance = isDbotx
        ? refreshDbotxBalance().catch((err) =>
            console.warn("[Main] Failed to refresh DBotX balance:", err),
          )
        : refreshPumpBalance().catch((err) =>
            console.warn("[Main] Failed to refresh PumpAPI balance:", err),
          );

      await refreshBalance;
    }

    startTelegramListener()
      .then(() => {
        initSignalQueue(CONFIG.telegramChannelUserName);
      })
      .catch((err) => console.error("[Main] Telegram listener failed:", err));

    console.log("[Main] All services started");
  },

  stop(): void {
    if (CONFIG.liveMode && isDbotx) {
      stopDbotxMonitor();
      disconnectDbotxTradeWs();
    }
    stopTrading();
    stopSignalQueue();
    positionEngine.stop();
    stopPriceEngine();
    disconnectDataWs();
    stopTelegramListener();
    shutdownTelegramBot();
    console.log("[Main] All services stopped");
  },
};

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

services
  .start()
  .catch((err) => {
    console.error("[Main] Startup failed:", err);
    services.stop();
    process.exit(1);
  });
