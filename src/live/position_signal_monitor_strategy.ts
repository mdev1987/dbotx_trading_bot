/**
 * Live Trading — Signal Monitor Strategy (AveSignalMonitor Mode).
 *
 * Used when the Telegram channel is "avesignalmonitor".
 *
 * Behaviour:
 *   • No maximum-position cap — every valid signal opens a position.
 *   • No signal deduplication is applied (already deduped upstream).
 *   • If the same token already has an open position, a new entry is opened
 *     alongside the existing one — the old position is NOT closed on re-entry.
 *   • Positions are closed via:
 *       — Server-managed TP/SL (configured at buy time).
 *       — Client-side trailing stop (via trailing_stop.ts).
 *       — Client-side trailing take-profit (via trailing_stop.ts).
 *       — Pump message (closes the oldest matching position for that token).
 *   • Signal pause/start control is respected.
 */
import { concatMap, filter, map, withLatestFrom } from "rxjs/operators";
import { telegramSignal$ } from "../telegram/telegram_listener";
import { signalPaused$ } from "../telegram/signal_control";
import type {
  AveSignalMonitorSignal,
  AveSignalMonitorPump,
} from "../telegram/ave_signal_monitor_parser";
import {
  openPosition,
  _latestPositions,
  closePositionById,
} from "./position_core";

// ---------------------------------------------------------------------------
// Pump-result observable
// ---------------------------------------------------------------------------

/**
 * Observable that emits only pump-result messages from the raw signal stream.
 */
const signalMonitorPump$ = telegramSignal$.pipe(
  filter(
    (s): s is AveSignalMonitorPump =>
      (s as AveSignalMonitorPump).type === "ave_monitor_pump",
  ),
);

// ---------------------------------------------------------------------------
// Monitor signal observable — no dedup
// ---------------------------------------------------------------------------

/**
 * Observable that emits only valid buy signals (Solana only).
 * No deduplication is applied — each signal opens a new position.
 */
const signalMonitorSignal$ = telegramSignal$.pipe(
  filter(
    (s): s is AveSignalMonitorSignal =>
      (s as AveSignalMonitorSignal).type === "ave_monitor_signal",
  ),
  filter((s) => s.chain === "solana"),
);

// ---------------------------------------------------------------------------
// Strategy bootstrap
// ---------------------------------------------------------------------------

/**
 * Start the signal monitor strategy by subscribing to the pump and signal streams.
 *
 * Called as a side-effect from position_manager.ts.
 */
export function startMonitorStrategy(): void {
  /** ---- Handle pump results: close the oldest matching position ---- */
  signalMonitorPump$
    .pipe(
      concatMap(async (pump) => {
        try {
          console.log(
            `[live/monitor-strategy] Pump result for ${pump.tokenName} — scanning positions`,
          );

          /** Find the oldest open position for this token address. */
          let oldestPos: { id: number; openedAt: number } | null = null;

          for (const pos of _latestPositions.values()) {
            if (
              pos.status === "open" &&
              pos.token === pump.contractAddress &&
              (oldestPos === null || pos.openedAt < oldestPos.openedAt)
            ) {
              oldestPos = { id: pos.id, openedAt: pos.openedAt };
            }
          }

          if (oldestPos) {
            console.log(
              `[live/monitor-strategy] Pump: closing oldest position ${oldestPos.id} for ${pump.tokenName}`,
            );
            await closePositionById(oldestPos.id, "pump_message");
          } else {
            console.log(
              `[live/monitor-strategy] Pump: no open position found for ${pump.tokenName}`,
            );
          }
        } catch (err) {
          console.error("[live/monitor-strategy] Pump handler error:", err);
        }
      }),
    )
    .subscribe();

  /** ---- Handle new signals: open a position for each ---- */
  signalMonitorSignal$
    .pipe(
      /** Respect the pause/start signal control. */
      withLatestFrom(signalPaused$),
      filter(([, paused]) => {
        if (paused) console.log("[live/monitor-strategy] Paused — skipping signal");
        return !paused;
      }),
      map(([signal]) => signal),

      /** Process signals sequentially, but no cap. */
      concatMap(async (signal) => {
        try {
          console.log(
            `[live/monitor-strategy] Opening position for ${signal.tokenName}`,
          );
          await openPosition(signal);
        } catch (err) {
          console.error("[live/monitor-strategy] Open error:", err);
        }
      }),
    )
    .subscribe();

  console.log("[live/monitor-strategy] Started: no position cap, pump-driven");
}
