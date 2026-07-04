// AveSignalMonitor strategy — no max-position limit, no expiry, pump-result consumer.
//
// This strategy is used when the monitored channel is `avesignalmonitor`.
// Every accepted signal is opened immediately (no cap).  Positions are closed
// when a matching pump-result message arrives from the same channel.
import { concatMap, filter } from "rxjs/operators";
import { telegramSignal$ } from "../telegram/telegram_listener";
import type { AveSignalMonitorPump } from "../telegram/ave_signal_monitor_parser";
import { acceptedSignal$ } from "../telegram/signals_stream";
import { openPosition, closePosition, _latestPositions } from "./position_core";

// ──────────────────────────────────────────────
// Pump-result observable (filtered from raw signal stream)
// ──────────────────────────────────────────────

/**
 * Subset of the raw telegram message stream that only contains
 * `ave_monitor_pump` events — the pump-result announcements that tell us
 * a monitored token just pumped.
 */
const signalMonitorPump$ = telegramSignal$.pipe(
  // Narrow the union type to AveSignalMonitorPump via a type guard.
  filter(
    (s): s is AveSignalMonitorPump =>
      (s as AveSignalMonitorPump).type === "ave_monitor_pump",
  ),
);

// ──────────────────────────────────────────────
// Signal subscription — accept every signal, no limits
// ──────────────────────────────────────────────

// Open every accepted signal immediately.
// concatMap serialises execution so we never race two openPosition calls.
acceptedSignal$
  .pipe(concatMap(async (signal) => openPosition(signal)))
  .subscribe();

// ──────────────────────────────────────────────
// Pump result consumer — close position when a pump arrives
// ──────────────────────────────────────────────

// Listen for pump-result messages and close the matching open position.
signalMonitorPump$.subscribe((pump: AveSignalMonitorPump) => {
  // Scan all tracked positions for one whose contract matches the pump.
  for (const [pair, pos] of _latestPositions) {
    if (
      pos.signal.contractAddress === pump.contractAddress &&
      (pos.status === "open" || pos.status === "closing")
    ) {
      console.log(
        `[position_manager] Pump signal for ${pos.tokenName} ` +
          `(x${pump.multiplier}, jumped to ${pump.jumpedToK}K) — closing`,
      );
      // Close at the pump peak (simulated take-profit).
      closePosition(pair, "take_profit");
      return;
    }
  }
});
