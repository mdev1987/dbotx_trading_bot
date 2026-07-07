/**
 * Position Manager — shared module entry point
 * ==============================================
 *
 * Bootstraps the simulator's position-management infrastructure.
 * Unlike the previous version, ALL subscriptions are created explicitly
 * through startSimulatorTrading() so there are no module-level side effects.
 */

export * from "./position_core";
export type { PositionEvent } from "./types";

import { timer, Subscription } from "rxjs";
import { map, tap, withLatestFrom } from "rxjs/operators";
import { CONFIG } from "../config";
import { logger } from "../utils/logger";
import { startTrailingMonitor } from "./trailing_stop";
import type { PositionState } from "./types";
import { openPositions$, patchPositionById, closePositionById, startPnLTaskPoll, startTradePairPoll } from "./position_core";

const _subscriptions: Subscription[] = [];

export async function startSimulatorTrading(): Promise<void> {
  console.log("[sim/manager] Starting simulator trading mode...");

  // Step 1: Start PnL task polling (TP/SL monitoring via API)
  startPnLTaskPoll();
  console.log("[sim/manager] PnL task polling started");

  // Step 2: Start trade pair polling (balance & PnL tracking via API)
  startTradePairPoll();
  console.log("[sim/manager] Trade pair polling started");

  // Step 3: Start trailing monitor (client-side trailing stop/TP)
  startTrailingMonitor();
  console.log("[sim/manager] Trailing monitor started");

  // Step 4: Position expiry checker (TTL-based)
  const expirySub = startExpiryChecker();
  _subscriptions.push(expirySub);
  console.log("[sim/manager] Expiry checker started");

  // Step 5: Load channel strategy
  loadStrategy();
  console.log("[sim/manager] Strategy loaded");
}

function startExpiryChecker(): Subscription {
  return timer(CONFIG.expiryCheckMs, CONFIG.expiryCheckMs)
    .pipe(
      tap(() => logger.debug("[EXPIRY] Tick — checking positions...")),
      withLatestFrom(openPositions$),
      map(([, open]) => open),
      tap((open: PositionState[]) => {
        const now = Date.now();
        const maxAge = CONFIG.maxTtlSecs * 1000;

        for (const pos of open) {
          if (now - pos.openedAt >= maxAge) {
            closePositionById(pos.id, "expired");
            continue;
          }

          if (now < pos.expiresAt) continue;

          if (
            CONFIG.minProfitForTtlExtensionPct > 0 &&
            pos.currentProfitPercent >= CONFIG.minProfitForTtlExtensionPct
          ) {
            patchPositionById(pos.id, { expiresAt: now + CONFIG.baseTtlSecs * 1000 });
            continue;
          }

          closePositionById(pos.id, "expired");
        }
      }),
    )
    .subscribe();
}

function loadStrategy(): void {
  if (CONFIG.telegramChannelUserName === "avesignalmonitor") {
    void import("./position_signal_monitor_strategy");
  } else {
    void import("./position_default_strategy");
  }
}

export function stopSimulatorTrading(): void {
  console.log("[sim/manager] Shutting down simulator trading...");
  for (const sub of _subscriptions) {
    sub.unsubscribe();
  }
  _subscriptions.length = 0;
}
