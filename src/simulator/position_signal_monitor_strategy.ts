// AveSignalMonitor strategy — no max-position limit, no expiry, pump-result consumer.
//
// This strategy is used when the monitored channel is `avesignalmonitor`.
// **No signal deduplication is applied** (all signals from the channel are
// accepted).  If the same token already has an open position a new entry
// is opened alongside the existing one — the old position is **not** closed
// on re-entry.
//
// Positions are closed only via:
//   • TP / SL tasks   (configured in the simulator API)
//   • Trailing stop   (client-side, via trailing_stop.ts)
//   • Trailing TP     (client-side, via trailing_stop.ts)
//   • Partial TP      (simulator API partial-take-profit tiers)
//   • Pump message    (ave_monitor_pump — closes the **oldest** matching
//                      position for that contract address)
import { concatMap, filter } from "rxjs/operators";
import { telegramSignal$ } from "../telegram/telegram_listener";
import type {
  AveSignalMonitorSignal,
  AveSignalMonitorPump,
} from "../telegram/ave_signal_monitor_parser";
import {
  openPosition,
  handlePumpPartialExit,
  _latestPositions,
} from "./position_core";

// ──────────────────────────────────────────────
// Pump-result observable (filtered from raw signal stream)
// ──────────────────────────────────────────────

const signalMonitorPump$ = telegramSignal$.pipe(
  filter(
    (s): s is AveSignalMonitorPump =>
      (s as AveSignalMonitorPump).type === "ave_monitor_pump",
  ),
);

// ──────────────────────────────────────────────
// Monitor signal observable — no dedup
// ──────────────────────────────────────────────

const signalMonitorSignal$ = telegramSignal$.pipe(
  filter(
    (s): s is AveSignalMonitorSignal =>
      (s as AveSignalMonitorSignal).type === "ave_monitor_signal",
  ),
  filter((s) => s.chain === "solana"),
);

// ──────────────────────────────────────────────
// Signal subscription — accept every signal, no close-before-open
// ──────────────────────────────────────────────

signalMonitorSignal$
  .pipe(
    concatMap(async (signal) => {
      // Open a new position with force=true to bypass the pair-exists guard.
      // The old position (if any) for the same token is **not** closed —
      // it continues running until it hits TP/SL/trailing/pump.
      await openPosition(signal, { force: true });
    }),
  )
  .subscribe();

// ──────────────────────────────────────────────
// Pump result consumer — partial exit on **oldest** matching position
// ──────────────────────────────────────────────

signalMonitorPump$.subscribe((pump: AveSignalMonitorPump) => {
  let oldestId: number | undefined;
  let oldestTime = Infinity;
  let oldestName = "";

  for (const [pid, pos] of _latestPositions) {
    if (
      pos.signal.contractAddress === pump.contractAddress &&
      (pos.status === "open" || pos.status === "closing")
    ) {
      if (pos.openedAt < oldestTime) {
        oldestTime = pos.openedAt;
        oldestId = pid;
        oldestName = pos.tokenName;
      }
    }
  }

  if (oldestId !== undefined) {
    console.log(
      `[position_manager] Pump signal for ${oldestName} ` +
        `(x${pump.multiplier}, jumped to ${pump.jumpedToK}K) — partial sell 50 %, trailing manages rest`,
    );
    handlePumpPartialExit(oldestId, pump);
  }
});
