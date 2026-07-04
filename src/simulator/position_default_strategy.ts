// Default signal strategy — applies max-positions cap, signal queuing, and TTL-based position expiry.
import { timer } from "rxjs";
import { concatMap, map, withLatestFrom } from "rxjs/operators";
import { CONFIG } from "../config";
import { acceptedSignal$ } from "../telegram/signals_stream";
import {
  _latestPositions,
  openPosition,
  enqueueSignal,
  closePosition,
  patchPosition,
  openPositions$,
} from "./position_core";
import type { PositionState } from "./types";

// ──────────────────────────────────────────────
// Main signal subscription with max-positions & queue
// ──────────────────────────────────────────────

/**
 * Process incoming signals sequentially via concatMap.
 *
 * If the number of currently open or closing positions has reached the
 * configured maximum, the signal is enqueued for later processing instead
 * of being opened immediately.
 */
acceptedSignal$
  .pipe(
    // concatMap guarantees signals are handled one-at-a-time in FIFO order,
    // naturally forming a queue without an explicit data structure.
    concatMap(async (signal) => {
      try {
        // Count positions that are still live (open or in the process of closing).
        let openCount = 0;
        for (const pos of _latestPositions.values()) {
          if (pos.status === "open" || pos.status === "closing") openCount++;
        }

        // If at capacity, push the signal onto the queue for later.
        // It will be picked up automatically once a previous signal finishes.
        if (openCount >= CONFIG.maxPositions) {
          enqueueSignal(signal);
          return;
        }

        // Under the limit — open the position immediately.
        await openPosition(signal);
      } catch (err) {
        console.error(`[position_default_strategy] Error processing signal:`, err);
      }
    }),
  )
  .subscribe();

// ──────────────────────────────────────────────
// Position Expiry & TTL Renewal
// ──────────────────────────────────────────────

/**
 * Check every open position for expiry and, where configured, renew the TTL
 * if the position has accrued sufficient unrealised profit.
 *
 * The check follows a three-tier priority:
 *   1. Hard-cap max age → force close regardless of profit.
 *   2. TTL still valid   → skip (not yet due).
 *   3. Profit threshold met → extend TTL by `baseTtlSecs`.
 *   4. Otherwise         → expire the position.
 *
 * @param open - Array of currently open positions to evaluate.
 * @throws Propagation of any exception from closePosition / patchPosition.
 */
const checkPositionExpiry = (open: PositionState[]): void => {
  const now = Date.now();
  // Absolute maximum age — positions older than this are always killed.
  const maxAge = CONFIG.maxTtlSecs * 1000;

  for (const pos of open) {
    // --- Tier 1: Hard-cap enforcement --------------------------------
    if (now - pos.openedAt >= maxAge) {
      console.log(
        `[EXPIRY] Hard cap: ${pos.tokenName} ` +
          `(${((now - pos.openedAt) / 1000).toFixed(0)}s >= ${CONFIG.maxTtlSecs}s)`,
      );
      closePosition(pos.pair, "expired");
      continue;
    }

    // --- Tier 2: TTL still running — nothing to do yet ---------------
    if (now < pos.expiresAt) continue;

    // --- Tier 3: Position is profitable enough → extend its life ------
    if (
      CONFIG.minProfitForTtlExtensionPct > 0 &&
      pos.currentProfitPercent >= CONFIG.minProfitForTtlExtensionPct
    ) {
      patchPosition(pos.pair, { expiresAt: now + CONFIG.baseTtlSecs * 1000 });
      console.log(
        `[EXPIRY] Renewed ${pos.tokenName} ` +
          `(profit ${(pos.currentProfitPercent * 100).toFixed(2)}% >= ` +
          `${(CONFIG.minProfitForTtlExtensionPct * 100).toFixed(2)}%)`,
      );
      continue;
    }

    // --- Tier 4: TTL expired without qualifying profit — close -------
    console.log(
      `[EXPIRY] Expired: ${pos.tokenName} ` +
        `(${((now - pos.openedAt) / 1000).toFixed(0)}s > ${CONFIG.baseTtlSecs}s)`,
    );
    closePosition(pos.pair, "expired");
  }
};

// Poll on a fixed interval, grab the latest open positions, and feed
// them into the expiry checker.
timer(CONFIG.expiryCheckMs, CONFIG.expiryCheckMs)
  .pipe(
    // Attach the current open-positions snapshot to each tick.
    withLatestFrom(openPositions$),
    // We only need the positions array — discard the tick value.
    map(([, open]) => open),
  )
  .subscribe(checkPositionExpiry);
