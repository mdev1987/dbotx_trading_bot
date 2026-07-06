/**
 * Position Manager — shared module entry point
 * ==============================================
 *
 * This module is loaded as a side-effect import from `main.ts` and is
 * responsible for bootstrapping the simulator's position-management
 * infrastructure.  It performs four duties in order:
 *
 * 1. **Re-export** the shared position core (`position_core.ts`) so that
 *    external modules can access the store, event bus, and lifecycle
 *    functions through a single import path.
 *
 * 2. **Start the trailing monitor** (`trailing_stop.ts`) unconditionally.
 *    Trailing stop-loss and trailing take-profit apply to every open
 *    position regardless of channel strategy.
 *
 * 3. **Start the TTL expiry checker** — applies to ALL channel strategies.
 *
 * 4. **Load the channel-specific strategy** via dynamic import.  The
 *    import is intentionally not awaited — the strategy module creates
 *    its own subscriptions at module-load time.
 *
 * Channel strategies
 * ------------------
 * | Channel                | Strategy file                     | Behaviour            |
 * |------------------------|-----------------------------------|-----------------------|
 * | `avesignalmonitor`     | position_signal_monitor_strategy | No caps, pump-driven  |
 * | (any other)            | position_default_strategy         | Max pos, queue, TTL   |
 */

export * from "./position_core";
export type { PositionEvent } from "./types";

import { timer } from "rxjs";
import { map, withLatestFrom } from "rxjs/operators";
import { CONFIG } from "../config";
import { startTrailingMonitor } from "./trailing_stop";
import type { PositionState } from "./types";
import {
  openPositions$,
  patchPositionById,
  closePositionById,
} from "./position_core";

// ── Step 1: Start trailing monitors ────────────────────────────────────────
// Watches all open positions via the WebSocket price stream and auto-closes
// them when a trailing threshold is breached.  Always runs — the underlying
// module checks the config and is a no-op when all trailing distances are 0.
startTrailingMonitor();

// ── Step 2: Position Expiry & TTL Renewal ──────────────────────────────────
// Applies to all strategies.  Checks every open position on a fixed interval
// and either extends the TTL (when profitable) or expires the position.
//
// The check follows a three-tier priority:
//   1. Hard-cap max age → force close regardless of profit.
//   2. TTL still valid   → skip (not yet due).
//   3. Profit threshold met → extend TTL by baseTtlSecs.
//   4. Otherwise         → expire the position.
const checkPositionExpiry = (open: PositionState[]): void => {
  const now = Date.now();
  const maxAge = CONFIG.maxTtlSecs * 1000;

  for (const pos of open) {
    if (now - pos.openedAt >= maxAge) {
      console.log(
        `[EXPIRY] Hard cap: ${pos.tokenName} ` +
          `(${((now - pos.openedAt) / 1000).toFixed(0)}s >= ${CONFIG.maxTtlSecs}s)`,
      );
      closePositionById(pos.id, "expired");
      continue;
    }

    if (now < pos.expiresAt) continue;

    if (
      CONFIG.minProfitForTtlExtensionPct > 0 &&
      pos.currentProfitPercent >= CONFIG.minProfitForTtlExtensionPct
    ) {
      patchPositionById(pos.id, { expiresAt: now + CONFIG.baseTtlSecs * 1000 });
      console.log(
        `[EXPIRY] Renewed ${pos.tokenName} ` +
          `(profit ${(pos.currentProfitPercent * 100).toFixed(2)}% >= ` +
          `${(CONFIG.minProfitForTtlExtensionPct * 100).toFixed(2)}%)`,
      );
      continue;
    }

    console.log(
      `[EXPIRY] Expired: ${pos.tokenName} ` +
        `(${((now - pos.openedAt) / 1000).toFixed(0)}s > ${CONFIG.baseTtlSecs}s)`,
    );
    closePositionById(pos.id, "expired");
  }
};

timer(CONFIG.expiryCheckMs, CONFIG.expiryCheckMs)
  .pipe(
    withLatestFrom(openPositions$),
    map(([, open]) => open),
  )
  .subscribe(checkPositionExpiry);

// ── Step 3: Load channel strategy ──────────────────────────────────────────
// The `void` keyword signals that we are intentionally not awaiting the
// dynamic import promise — the strategy module wires itself up via module
// scope subscriptions.
if (CONFIG.telegramChannelUserName === "avesignalmonitor") {
  void import("./position_signal_monitor_strategy");
} else {
  void import("./position_default_strategy");
}
