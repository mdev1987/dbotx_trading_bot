/**
 * Position Manager — shared module entry point
 * ==============================================
 *
 * This module is loaded as a side-effect import from `main.ts` and is
 * responsible for bootstrapping the simulator's position-management
 * infrastructure.  It performs three duties in order:
 *
 * 1. **Re-export** the shared position core (`position_core.ts`) so that
 *    external modules can access the store, event bus, and lifecycle
 *    functions through a single import path.
 *
 * 2. **Start the trailing monitor** (`trailing_stop.ts`) unconditionally.
 *    Trailing stop-loss and trailing take-profit apply to every open
 *    position regardless of channel strategy.
 *
 * 3. **Load the channel-specific strategy** via dynamic import.  The
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

import { CONFIG } from "../config";
import { startTrailingMonitor } from "./trailing_stop";

// ── Step 1: Start trailing monitors ────────────────────────────────────────
// Watches all open positions via the WebSocket price stream and auto-closes
// them when a trailing threshold is breached.  Always runs — the underlying
// module checks the config and is a no-op when all trailing distances are 0.
startTrailingMonitor();

// ── Step 2: Load channel strategy ──────────────────────────────────────────
// The `void` keyword signals that we are intentionally not awaiting the
// dynamic import promise — the strategy module wires itself up via module
// scope subscriptions.
if (CONFIG.telegramChannelUserName === "avesignalmonitor") {
  void import("./position_signal_monitor_strategy");
} else {
  void import("./position_default_strategy");
}
