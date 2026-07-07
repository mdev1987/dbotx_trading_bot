/**
 * Live Trading — Trailing Stop & Trailing Take-Profit Monitor.
 *
 * Watches real-time market data (pairUpdate$) for open positions and
 * automatically triggers a market sell when configured thresholds are breached.
 *
 * Two independent trailing modes run in parallel for every open position:
 *
 * 1. Trailing Stop Loss
 *    - Activates only after price rises trailingActivationPct above entry.
 *    - If price then drops trailingStopPct from the peak, fires a market sell
 *      with reason "trailing_stop".
 *
 * 2. Trailing Take-Profit
 *    - Always active from entry (no activation threshold).
 *    - If price drops trailingTpPct from the peak, fires a market sell with
 *      reason "trailing_tp".
 *
 * Both modes share the same peak-price tracking.  If both thresholds are
 * breached simultaneously the trailing stop takes priority.
 */
import { Subscription } from "rxjs";
import { filter, map, tap, withLatestFrom } from "rxjs/operators";
import { LIVE_CONFIG } from "./config";
import { pairUpdate$ } from "../market/dbotx_data_ws";
import {
  openPositions$,
  closePositionById,
  emitEvent,
} from "./position_core";

/**
 * Start the trailing stop and trailing TP monitors.
 *
 * Both monitors run as RxJS subscriptions that observe the merged stream
 * of open positions and pair price updates.
 *
 * Each monitor is a no-op when its corresponding distance config is 0.
 *
 * @returns A Subscription that can be unsubscribed to stop monitoring.
 */
export function startTrailingMonitor(): Subscription {
  /** Combine the latest open positions with each incoming price update. */
  const priceWithPositions$ = pairUpdate$.pipe(
    withLatestFrom(openPositions$),
    map(([update, positions]) => {
      /** Filter to positions that match this price update's LP address. */
      const matching = positions.filter(
        (pos) => pos.pair === update.pair,
      );
      return { update, matching };
    }),
  );

  /** Guard: skip if both trailing distances are zero (disabled). */
  const trailingEnabled =
    LIVE_CONFIG.trailingStopPct > 0 || LIVE_CONFIG.trailingTpPct > 0;

  if (!trailingEnabled) {
    console.log("[live/trailing] Both trailing distances are 0 — monitor disabled");
    return new Subscription(); // Empty no-op subscription
  }

  console.log(
    `[live/trailing] Starting trailing monitor: ` +
      `activation=${(LIVE_CONFIG.trailingActivationPct * 100).toFixed(0)}% ` +
      `stop=${(LIVE_CONFIG.trailingStopPct * 100).toFixed(0)}% ` +
      `tp=${(LIVE_CONFIG.trailingTpPct * 100).toFixed(0)}%`,
  );

  /** ---- Trailing Stop Loss ---- */
  const trailingStopSub = priceWithPositions$
    .pipe(
      filter(() => LIVE_CONFIG.trailingStopPct > 0),
      tap(({ update, matching }) => {
        for (const pos of matching) {
          /** Skip positions without an entry price yet. */
          if (!pos.entryPriceUsd) continue;

          /** Skip positions that are already closing. */
          if (pos.status !== "open") continue;

          /** Calculate current drawdown from peak. */
          const currentPrice = update.priceUsd;
          if (!currentPrice || currentPrice <= 0) continue;

          /** Check if the trailing stop should be activated. */
          const gainPct =
            (pos.peakPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd;

          if (
            !pos.trailingActive &&
            gainPct >= LIVE_CONFIG.trailingActivationPct
          ) {
            /** Activate the trailing stop for this position. */
            pos.trailingActive = true;
            emitEvent({
              type: "updated",
              position: pos,
              detail: "Trailing stop activated",
            });
            console.log(
              `[live/trailing] Trailing activated for ${pos.tokenName} ` +
                `(gain=${(gainPct * 100).toFixed(1)}%)`,
            );
          }

          /** If active, check if the price has dropped enough to trigger. */
          if (pos.trailingActive) {
            const dropFromPeak =
              (pos.peakPriceUsd - currentPrice) / pos.peakPriceUsd;

            if (dropFromPeak >= LIVE_CONFIG.trailingStopPct) {
              console.log(
                `[live/trailing] Triggering stop for ${pos.tokenName}: ` +
                  `peak=$${pos.peakPriceUsd.toFixed(8)} ` +
                  `current=$${currentPrice.toFixed(8)} ` +
                  `drop=${(dropFromPeak * 100).toFixed(1)}%`,
              );

              /** Fire the sell.  Do not await — execute in background. */
              closePositionById(pos.id, "trailing_stop").catch((err) => {
                console.error(
                  `[live/trailing] Failed to close ${pos.tokenName} on trailing stop:`,
                  err,
                );
              });
            }
          }
        }
      }),
    )
    .subscribe();

  /** ---- Trailing Take-Profit ---- */
  const trailingTpSub = priceWithPositions$
    .pipe(
      filter(() => LIVE_CONFIG.trailingTpPct > 0),
      tap(({ update, matching }) => {
        for (const pos of matching) {
          /** Skip positions without entry price or already closing. */
          if (!pos.entryPriceUsd) continue;
          if (pos.status !== "open") continue;

          const currentPrice = update.priceUsd;
          if (!currentPrice || currentPrice <= 0) continue;

          /** Trailing TP is always active — no activation threshold. */
          const dropFromPeak =
            (pos.peakPriceUsd - currentPrice) / pos.peakPriceUsd;

          if (dropFromPeak >= LIVE_CONFIG.trailingTpPct) {
            console.log(
              `[live/trailing] Triggering TP for ${pos.tokenName}: ` +
                `peak=$${pos.peakPriceUsd.toFixed(8)} ` +
                `current=$${currentPrice.toFixed(8)} ` +
                `drop=${(dropFromPeak * 100).toFixed(1)}%`,
            );

            /** Fire the sell. */
            closePositionById(pos.id, "trailing_tp").catch((err) => {
              console.error(
                `[live/trailing] Failed to close ${pos.tokenName} on trailing TP:`,
                err,
              );
            });
          }
        }
      }),
    )
    .subscribe();

  /** Return a composite subscription that unsubscribes both monitors. */
  return new Subscription(() => {
    trailingStopSub.unsubscribe();
    trailingTpSub.unsubscribe();
  });
}
