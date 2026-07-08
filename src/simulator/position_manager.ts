/**
 * Position Manager — shared module entry point
 * ==============================================
 *
 * Bootstraps the simulator's position-management infrastructure.
 * Unlike the previous version, ALL subscriptions are created explicitly
 * through startSimulatorTrading() so there are no module-level side effects.
 */

export * from "./position_core";            // Re-export all core position management functions and observables
export type { PositionEvent } from "./types";   // Re-export PositionEvent type for consumers

import { timer, Subscription } from "rxjs";                                  // RxJS timer factory + Subscription type
import { map, tap, withLatestFrom } from "rxjs/operators";                   // Pipeable operators for stream transformation
import { CONFIG } from "../config";                                          // Centralised bot configuration singleton
import { logger } from "../utils/logger";                                    // Structured logging utility
import { startTrailingMonitor } from "./trailing_stop";                       // Client-side trailing stop-loss monitor
import type { PositionState } from "./types";                                // PositionState type for the expiry checker
import { openPositions$, patchPositionById, closePositionById, startPnLTaskPoll, startTradePairPoll } from "./position_core";  // Core position CRUD + polling triggers

/** Holds active RxJS subscriptions for cleanup on shutdown */
const _subscriptions: Subscription[] = [];  // Tracked subscriptions, unsubscribed on stop

/**
 * Bootstraps all simulator trading subsystems:
 * PnL polling, trade pair polling, trailing stop monitor,
 * position expiry checker, and channel-specific strategy loading.
 */
export async function startSimulatorTrading(): Promise<void> {  // Bootstrap all simulator subsystems
  console.log("[sim/manager] Starting simulator trading mode...");  // Log mode start

  // Step 1: Start PnL task polling (TP/SL monitoring via API)
  startPnLTaskPoll();  // Begin polling for TP/SL task results from simulator API
  console.log("[sim/manager] PnL task polling started");  // Confirm PnL polling active

  // Poll the simulator API for open trade pairs (balance & PnL)
  startTradePairPoll();  // Begin polling for open trade pairs and their PnL
  console.log("[sim/manager] Trade pair polling started");  // Confirm trade pair polling active

  // Start client-side trailing stop/TP monitor that watches price movement
  startTrailingMonitor();  // Begin the trailing stop-loss price watcher
  console.log("[sim/manager] Trailing monitor started");  // Confirm trailing monitor active

  // Start periodic checker that closes expired positions or extends TTL on profitable ones
  const expirySub = startExpiryChecker();  // Create and initialise the expiry checker timer
  _subscriptions.push(expirySub);  // Track subscription for later cleanup
  console.log("[sim/manager] Expiry checker started");  // Confirm expiry checker active

  // Dynamically import the strategy module that matches the Telegram channel
  loadStrategy();  // Import the correct strategy based on channel config
  console.log("[sim/manager] Strategy loaded");  // Confirm strategy module loaded
}

/**
 * Creates a periodic timer that checks all open positions for TTL expiry.
 * Profitable positions (above minProfitForTtlExtensionPct) get their TTL extended;
 * all other expired positions are closed.
 */
function startExpiryChecker(): Subscription {  // Create periodic timer that evaluates position TTL expiry
  // Create a timer that fires every expiryCheckMs milliseconds
  return timer(CONFIG.expiryCheckMs, CONFIG.expiryCheckMs)
    .pipe(
      tap(() => logger.debug("[EXPIRY] Tick — checking positions...")), // Log each tick
      withLatestFrom(openPositions$),  // Combine tick with latest open positions
      map(([, open]) => open),         // Discard the tick value, keep positions
      tap((open: PositionState[]) => {
        const now = Date.now();
        const maxAge = CONFIG.maxTtlSecs * 1000;  // Maximum allowed age in ms

        for (const pos of open) {
          // Hard cap: close if position exceeds maxTtlSecs
          if (now - pos.openedAt >= maxAge) {
            closePositionById(pos.id, "expired");
            continue;
          }

          // Skip if position has not yet reached its base TTL
          if (now < pos.expiresAt) continue;

          // If profitable enough, extend TTL instead of closing
          if (
            CONFIG.minProfitForTtlExtensionPct > 0 &&
            pos.currentProfitPercent >= CONFIG.minProfitForTtlExtensionPct
          ) {
            patchPositionById(pos.id, { expiresAt: now + CONFIG.baseTtlSecs * 1000 });
            continue;
          }

          // Position expired and not profitable enough — close it
          closePositionById(pos.id, "expired");
        }
      }),
    )
    .subscribe();  // Subscribe to start the timer
}  // End of startExpiryChecker

/**
 * Dynamically imports the position-filling strategy based on the Telegram channel.
 * - "avesignalmonitor" → signal monitor strategy
 * - Everything else     → default strategy
 */
function loadStrategy(): void {  // Dynamically import the appropriate strategy module
  if (CONFIG.telegramChannelUserName === "avesignalmonitor") {
    void import("./position_signal_monitor_strategy");  // Signal-monitor-based position opening
  } else {
    void import("./position_default_strategy");         // Default signal-based position opening
  }
}  // End of loadStrategy

/**
 * Gracefully shuts down all simulator trading subsystems by unsubscribing
 * from all active RxJS subscriptions.
 */
export function stopSimulatorTrading(): void {  // Gracefully shut down all simulator subsystems
  console.log("[sim/manager] Shutting down simulator trading...");  // Log shutdown
  // Unsubscribe from all tracked subscriptions
  for (const sub of _subscriptions) {  // Iterate over active subscriptions
    sub.unsubscribe();  // Tear down each subscription
  }
  _subscriptions.length = 0;  // Clear the subscriptions array
}  // End of stopSimulatorTrading
