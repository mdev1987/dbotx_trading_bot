import { timer, Subscription } from "rxjs";
import { tap } from "rxjs/operators";
import { isPanicMode, enablePanic } from "./panic";
import { LIVE_CONFIG } from "./config";

let _lastWsMessage = Date.now();
let _lastBalanceUpdate = Date.now();
let _lastPriceUpdate = Date.now();
let _lastWatchdogTick = 0;

export function markWsMessage(): void {
  _lastWsMessage = Date.now();
}

export function markBalanceUpdate(): void {
  _lastBalanceUpdate = Date.now();
}

export function markPriceUpdate(): void {
  _lastPriceUpdate = Date.now();
}

function checkHealth(): void {
  const now = Date.now();

  if (now - _lastWsMessage > LIVE_CONFIG.watchdogWsStaleMs) {
    console.warn(
      `[live/watchdog] WS message stale: ${(now - _lastWsMessage) / 1000}s since last message`,
    );
  }

  if (now - _lastBalanceUpdate > LIVE_CONFIG.watchdogBalanceStaleMs) {
    console.warn(
      `[live/watchdog] Balance update stale: ${(now - _lastBalanceUpdate) / 1000}s since last update`,
    );
  }

  if (now - _lastPriceUpdate > LIVE_CONFIG.watchdogPriceStaleMs) {
    console.warn(
      `[live/watchdog] Price update stale: ${(now - _lastPriceUpdate) / 1000}s since last update`,
    );
  }

  _lastWatchdogTick = now;
}

export function startWatchdog(
  hasOpenPositions?: () => boolean,
): Subscription {
  return timer(LIVE_CONFIG.watchdogIntervalMs, LIVE_CONFIG.watchdogIntervalMs)
    .pipe(
      tap(() => {
        if (isPanicMode()) return;

        // Skip health checks when there are no open positions — stale data is
        // expected (no WS subscriptions, no price feeds, no balance polling).
        if (hasOpenPositions && !hasOpenPositions()) return;

        checkHealth();
      }),
    )
    .subscribe();
}
