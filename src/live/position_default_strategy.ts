/**
 * Live Trading — Default Signal Strategy (Scanner Mode).
 *
 * Used when the Telegram channel is "avesolanatokenscanner".
 *
 * Behaviour:
 *   • Applies a maximum-position cap (LIVE_CONFIG.maxPositions).
 *   • When at capacity, enqueues signals for later processing.
 *   • Processes signals sequentially (FIFO) via concatMap.
 *   • Each signal is checked against the pause/start signal control.
 *
 * Positions are closed by the server (TP/SL) or by the trailing stop monitor.
 */
import { concatMap, filter, map, withLatestFrom, tap } from "rxjs/operators";
import { LIVE_CONFIG } from "./config";
import { acceptedSignal$ } from "../telegram/signals_stream";
import { signalPaused$ } from "../telegram/signal_control";
import {
  _latestPositions,
  openPosition,
  enqueueSignal,
  dequeueSignal,
  positionClosed$,
  countOpenPositions,
} from "./position_core";

/**
 * Start the default strategy by subscribing to the accepted signal stream.
 *
 * This is called as a side-effect from position_manager.ts.
 * The subscription lives for the lifetime of the application.
 */
export function startDefaultStrategy(): void {
  acceptedSignal$
    .pipe(
      /** Respect the pause/start signal control. */
      withLatestFrom(signalPaused$),
      filter(([, paused]) => {
        if (paused) console.log("[live/default-strategy] Paused — skipping signal");
        return !paused;
      }),
      map(([signal]) => signal),

      /** Process signals one-at-a-time in FIFO order. */
      concatMap(async (signal) => {
        try {
          /** Count positions that are still live (open or closing). */
          let openCount = 0;
          for (const pos of _latestPositions.values()) {
            if (pos.status === "open" || pos.status === "closing") openCount++;
          }

          /** If at capacity, enqueue the signal for later. */
          if (openCount >= LIVE_CONFIG.maxPositions) {
            enqueueSignal(signal);
            return;
          }

          /** Under the limit — open the position immediately. */
          await openPosition(signal);

          /** After opening, check if we should dequeue a waiting signal. */
          tryDequeue();
        } catch (err) {
          console.error("[live/default-strategy] Error processing signal:", err);
        }
      }),
    )
    .subscribe();

  /** Subscribe to position closed events: try to dequeue when a slot opens. */
  positionClosed$
    .pipe(
      tap(() => {
        console.log(
          `[live/default-strategy] Position closed — open slots: ` +
            `${LIVE_CONFIG.maxPositions - countOpenPositions()}`,
        );
        tryDequeue();
      }),
    )
    .subscribe();

  console.log(
    `[live/default-strategy] Started: maxPositions=${LIVE_CONFIG.maxPositions} ` +
      `queueSize=${LIVE_CONFIG.signalQueueSize}`,
  );
}

/**
 * Try to dequeue and process the next queued signal.
 * Only dequeues if under the max-positions cap.
 */
function tryDequeue(): void {
  if (countOpenPositions() >= LIVE_CONFIG.maxPositions) {
    console.log(
      `[live/default-strategy] Cannot dequeue — at max positions (${countOpenPositions()})`,
    );
    return;
  }

  const signal = dequeueSignal();
  if (signal) {
    console.log(
      `[live/default-strategy] Dequeuing signal for ${signal.tokenName}`,
    );
    openPosition(signal).catch((err) => {
      console.error("[live/default-strategy] Dequeue open failed:", err);
    });
  }
}
