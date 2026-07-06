// Default signal strategy — applies max-positions cap, signal queuing, and TTL-based position expiry.
import { concatMap } from "rxjs/operators";
import { CONFIG } from "../config";
import { acceptedSignal$ } from "../telegram/signals_stream";
import {
  _latestPositions,
  openPosition,
  enqueueSignal,
} from "./position_core";

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

// NOTE: TTL expiry is now handled in position_manager.ts (applies to all strategies).
