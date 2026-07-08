/**
 * Live Trading — Position Manager Entry Point.
 *
 * This module is loaded as a side-effect import from main.ts when
 * LIVE_MODE=true.  It bootstraps the live trading infrastructure:
 *
 * 1. Re-export core position functions.
 * 2. Connect the trade results WebSocket.
 * 3. Subscribe WS trade events to the position core.
 * 4. Subscribe to price updates for trailing/profit tracking.
 * 5. Start the TTL expiry checker.
 * 6. Start the trailing stop monitor.
 * 7. Resolve the configured wallet (sanity check).
 * 8. Run startup recovery.
 * 9. Load the channel-appropriate strategy.
 *
 * All subscriptions are managed collectively so shutdown is clean.
 */
export * from "./position_core";
export type { PositionEvent } from "./types";

import { LIVE_CONFIG } from "./config";
import { connectTradeResultsWs, disconnectTradeResultsWs } from "./trade_results_ws";
import {
  subscribeToTradeEvents,
  startTtlChecker,
  startPricePolling,
  subscribeToPriceUpdates,
  recoverOpenPositions,
  resetDailyLoss,
  loadDailyLossFromDb,
  countOpenPositions,
} from "./position_core";
import { startTrailingMonitor } from "./trailing_stop";
import { resolveConfiguredWallet, refreshBalance$ } from "./wallet";
import { Subscription } from "rxjs";
import { getLiveDb, loadAllPositions } from "./persistence";
import { startWatchdog, markWsMessage, markBalanceUpdate, markPriceUpdate } from "./watchdog";
import { startReconciliation } from "./reconciliation";
import { maskWalletId, maskAddress } from "../shared/mask";

/** Handle for cleaning up all subscriptions on shutdown. */
const _subscriptions: Subscription[] = [];

/**
 * Bootstrap the live trading system.
 *
 * Called once at startup.  All initialization errors are caught and logged
 * so that a non-critical failure (e.g., WS connection) does not prevent the
 * rest of the system from starting.
 */
export async function startLiveTrading(): Promise<void> {
  console.log("[live/manager] Starting live trading mode...");

  /** Step 0: Initialize persistence (creates SQLite database + runs migrations). */
  try {
    getLiveDb();
    console.log("[live/manager] Live state database ready");
  } catch (err) {
    console.error("[live/manager] Failed to initialize database:", err);
    throw err;
  }

  /** Reset and reload the daily loss tracker on startup. */
  resetDailyLoss();
  loadDailyLossFromDb();

  /** Step 1: Verify the configured wallet exists. */
  try {
    const wallet = await resolveConfiguredWallet();
    console.log(
      `[live/manager] Wallet verified: id=${maskWalletId(wallet.id)} address=${maskAddress(wallet.address)} name=${wallet.name}`,
    );

    /** Check that the wallet address matches config. */
    if (wallet.address !== LIVE_CONFIG.walletAddress) {
      console.warn(
        `[live/manager] Wallet address mismatch: config says "${maskAddress(LIVE_CONFIG.walletAddress)}" ` +
          `but API returns "${maskAddress(wallet.address)}". Check LIVE_WALLET_ADDRESS.`,
      );
    }
  } catch (err) {
    console.error("[live/manager] Wallet verification failed:", err);
    /** Wallet verification is critical — abort if we can't resolve the wallet. */
    throw err;
  }

  /** Step 2: Trigger initial balance fetch. */
  refreshBalance$.next();

  /** Step 3: Connect to the trade results WebSocket. */
  try {
    await connectTradeResultsWs();
    console.log("[live/manager] Trade results WS connected");
  } catch (err) {
    console.error("[live/manager] Trade results WS connection failed:", err);
    /** WS is critical for live trading — abort. */
    throw err;
  }

  /** Step 4: Subscribe WS trade events to position core. */
  const tradeEventSub = subscribeToTradeEvents();
  _subscriptions.push(tradeEventSub);

  /** Step 5: Subscribe to price updates for trailing and profit tracking. */
  const priceSub = subscribeToPriceUpdates();
  _subscriptions.push(priceSub);

  /** Step 5b: Start REST API price polling (fallback for broken WS pairInfo feed). */
  const pricePollSub = startPricePolling();
  _subscriptions.push(pricePollSub);

  /** Step 6: Start the TTL expiry checker. */
  const ttlSub = startTtlChecker();
  _subscriptions.push(ttlSub);

  /** Step 7: Start the trailing stop/TP monitor. */
  const trailingSub = startTrailingMonitor();
  _subscriptions.push(trailingSub);

  /** Step 8: Run startup recovery (hard stop on failure). */
  console.log("[live/manager] Running startup recovery...");
  await recoverOpenPositions();
  console.log("[live/manager] Recovery complete");

  /** Step 9: Start the watchdog heartbeat monitor. */
  const watchdogSub = startWatchdog(() => countOpenPositions() > 0);
  _subscriptions.push(watchdogSub);

  /** Step 10: Start periodic exchange reconciliation. */
  const reconcileSub = startReconciliation();
  _subscriptions.push(reconcileSub);

  /** Step 11: Load the channel-appropriate strategy. */
  loadStrategy();

  console.log("[live/manager] Live trading started successfully");
}

/**
 * Load the strategy module corresponding to the configured Telegram channel.
 *
 * Dynamic import defers module loading and side-effect subscriptions
 * until after all infra is ready.
 */
function loadStrategy(): void {
  const channel = (process.env.TELEGRAM_CHANNEL_USERNAME ?? "").toLowerCase().trim();

  if (channel === "avesignalmonitor") {
    /** Pump-detection mode — no position limit. */
    import("./position_signal_monitor_strategy").then((mod) => {
      mod.startMonitorStrategy();
    });
  } else if (channel === "avesolanatokenscanner") {
    /** Scanner mode — position cap + queue. */
    import("./position_default_strategy").then((mod) => {
      mod.startDefaultStrategy();
    });
  } else {
    console.warn(
      `[live/manager] Unknown channel "${channel}" — no strategy loaded. ` +
        `Set TELEGRAM_CHANNEL_USERNAME to "avesignalmonitor" or "avesolanatokenscanner".`,
    );
  }
}

/**
 * Gracefully shut down all live trading subscriptions.
 */
export function stopLiveTrading(): void {
  console.log("[live/manager] Shutting down live trading...");

  /** Unsubscribe all RxJS subscriptions. */
  for (const sub of _subscriptions) {
    sub.unsubscribe();
  }
  _subscriptions.length = 0;

  /** Disconnect the trade results WebSocket. */
  disconnectTradeResultsWs();

  console.log("[live/manager] Live trading shut down");
}
