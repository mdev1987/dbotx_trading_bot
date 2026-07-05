/**
 * Trailing Stop Monitor
 *
 * Watches real-time market data (pairUpdate$) for open positions and
 * automatically triggers a market sell when the price drops a configured
 * distance below the peak price since entry.
 *
 * Supports two independent trailing modes that run in parallel:
 *
 * Trailing Stop Loss
 * ------------------
 * 1. A position is opened → its `entryPriceUsd` is recorded.
 * 2. As market data arrives, the peak price is continuously updated.
 * 3. Once the price rises `trailingActivationPct` % above entry, the
 *    trailing stop becomes active for that position.
 * 4. If the price then falls `trailingDistancePct` % from the peak, a
 *    market sell is submitted and the position is closed with reason
 *    `trailing_stop`.
 *
 * Trailing Take-Profit
 * --------------------
 * 1. Same peak-tracking as above.
 * 2. Always active from entry — no activation threshold.
 * 3. If the price falls `trailingTpDistancePct` % from the peak, a
 *    market sell is submitted and the position is closed with reason
 *    `take_profit`.
 *
 * Configuration (.env)
 * --------------------
 *   PAPER_TRAILING_ACTIVATION_PERCENT  — gain % needed to arm the trail stop
 *   PAPER_TRAILING_STOP_PERCENT        — drop % from peak that triggers the stop
 *   PAPER_TRAILING_TP_PERCENT          — drop % from peak that triggers TP (always active)
 *
 * Set both *STOP_PERCENT and *TP_PERCENT to 0 or leave empty to disable
 * their respective mode.
 */

import { CONFIG } from "../config";
import { pairUpdate$ } from "../market/dbotx_data_ws";
import { filter, map, withLatestFrom } from "rxjs/operators";
import {
  openPositions$,
  patchPositionById,
  closePositionById,
  emitEvent,
} from "./position_core";

/**
 * Initialise the trailing stop and trailing TP monitors.
 *
 * Subscribes to the `pairUpdate$` WebSocket stream and evaluates every
 * update against all currently open positions.  Both modes share the same
 * price-tracking pipe; the subscribe handler dispatches to the correct
 * close reason based on which rule fired.
 *
 * Safe to call multiple times — each mode's distance guard prevents
 * activation when the config value is zero / undefined.
 *
 * Must be called **after** the position store is ready (i.e. after
 * importing `position_core`).
 */
export function startTrailingMonitor(): void {
  const { trailingActivationPct, trailingDistancePct, trailingTpDistancePct } =
    CONFIG;

  // Check whether either trailing mode is enabled.
  const tsEnabled =
    !!trailingDistancePct && trailingDistancePct > 0;
  const tpEnabled =
    !!trailingTpDistancePct && trailingTpDistancePct > 0;

  if (!tsEnabled && !tpEnabled) {
    console.log(
      "[trailing] Disabled — both STOP_PERCENT and TP_PERCENT are 0 or unset",
    );
    return;
  }

  pairUpdate$
    .pipe(
      // ── Filter 1: attach open positions & require a price + matching entry ──
      // Combine every price update with the current snapshot of open positions.
      withLatestFrom(openPositions$),
      // Skip updates that carry no price, or that belong to a pair we don't
      // have an open position for (or whose entry price hasn't been set yet).
      filter(([update, open]) => {
        if (!update.priceUsd) return false;
        return open.some(
          (p) => p.pair === update.pair && p.entryPriceUsd !== null,
        );
      }),

      // ── Map: update peak price and (for TS) trailing activation ──
      map(([update, open]) => {
        // Find the specific position that matches this update pair.
        const pos = open.find((p) => p.pair === update.pair);
        if (!pos || !update.priceUsd) return null;

        const price = update.priceUsd;
        let { peakPriceUsd, trailingActive, entryPriceUsd } = pos;

        // Update peak price if the current price is a new all-time high.
        // This is shared by both trailing modes.
        if (price > peakPriceUsd) {
          peakPriceUsd = price;
          patchPositionById(pos.id, { peakPriceUsd });
        }

        // If the trailing stop is not yet armed, check whether the price has
        // risen far enough above the entry price to activate it.
        if (!trailingActive && entryPriceUsd !== null) {
          const activationPrice =
            entryPriceUsd * (1 + trailingActivationPct);

          if (price >= activationPrice) {
            trailingActive = true;
            patchPositionById(pos.id, { trailingActive: true });
            console.log(
              `[trailing] Activated stop for ${pos.tokenName} ` +
                `(price $${price} >= activation $${activationPrice})`,
            );
          }
        }

        return { pos, price, peakPriceUsd, trailingActive, entryPriceUsd };
      }),

      // ── Filter 2: remove null results (no matching position) ──
      filter((v): v is NonNullable<typeof v> => v !== null),

      // ── Filter 3: pass through when either trailing rule is breached ──
      // Trailing stop requires the stop to be armed; trailing TP is always active.
      filter(({ trailingActive, peakPriceUsd, price, entryPriceUsd }) => {
        if (entryPriceUsd === null) return false;

        // Trailing stop: price dropped below the stop trail.
        if (
          tsEnabled &&
          trailingActive &&
          price <= peakPriceUsd * (1 - trailingDistancePct)
        ) {
          return true;
        }

        // Trailing TP: price dropped below the TP trail.
        if (
          tpEnabled &&
          price <= peakPriceUsd * (1 - trailingTpDistancePct)
        ) {
          return true;
        }

        return false;
      }),
    )
    // ── Subscribe: execute the sell for whichever rule fired ──
    .subscribe(({ pos, price, peakPriceUsd, trailingActive }) => {
      // Priority: trailing stop (loss prevention) over trailing TP (profit capture).
      if (
        tsEnabled &&
        trailingActive &&
        price <= peakPriceUsd * (1 - trailingDistancePct)
      ) {
        const trailPrice = peakPriceUsd * (1 - trailingDistancePct);

        console.log(
          `[trailing] Stop triggered for ${pos.tokenName}: ` +
            `price $${price} dropped below trail $${trailPrice} ` +
            `(peak $${peakPriceUsd})`,
        );

        emitEvent({
          type: "trailing_triggered",
          position: pos,
          detail: `Trailing stop: price $${price} below $${trailPrice}`,
        });

        closePositionById(pos.id, "trailing_stop");
        return;
      }

      if (
        tpEnabled &&
        price <= peakPriceUsd * (1 - trailingTpDistancePct)
      ) {
        const trailPrice = peakPriceUsd * (1 - trailingTpDistancePct);

        console.log(
          `[trailing] TP triggered for ${pos.tokenName}: ` +
            `price $${price} dropped below trail $${trailPrice} ` +
            `(peak $${peakPriceUsd})`,
        );

        emitEvent({
          type: "trailing_triggered",
          position: pos,
          detail: `Trailing TP: price $${price} below $${trailPrice}`,
        });

        closePositionById(pos.id, "take_profit");
      }
    });

  const labels: string[] = [];
  if (tsEnabled)
    labels.push(
      `stop ${(trailingActivationPct * 100).toFixed(0)}% / ${(trailingDistancePct * 100).toFixed(0)}%`,
    );
  if (tpEnabled)
    labels.push(
      `TP ${(trailingTpDistancePct * 100).toFixed(0)}%`,
    );
  console.log(`[trailing] Started — ${labels.join(", ")}`);
}
