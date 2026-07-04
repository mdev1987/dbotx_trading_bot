// Persists position lifecycle events to SQLite for historical tracking
import { Subscription } from "rxjs"; // RxJS subscription type for cleanup
import { getDb } from "./sqlite"; // Shared database instance
import { positionEvent$ } from "../simulator/position_manager"; // Position event stream
import type { PositionEvent } from "../simulator/position_manager"; // Position event type

/** Subscription reference for cleanup on stop */
let sub: Subscription | null = null;

/**
 * Start persisting position events to SQLite (subscribe to the event stream)
 */
export function startPersistence(): void {
  // Prevent double-initialization
  if (sub) return;

  // Get the shared database instance
  const db = getDb();

  // Prepared statement for upserting a position row
  const insertPos = db.prepare(`
    INSERT OR REPLACE INTO positions
      (order_id, pair, token, token_name,
       entry_price, entry_cost, size_sol, peak_price,
       close_reason, profit_pct, profit_usd,
       opened_at, closed_at, signal_json)
    VALUES
      ($order_id, $pair, $token, $token_name,
       $entry_price, $entry_cost, $size_sol, $peak_price,
       $close_reason, $profit_pct, $profit_usd,
       $opened_at, $closed_at, $signal_json)
  `);

  // Prepared statement for inserting a TP/SL task row
  const insertTask = db.prepare(`
    INSERT INTO tasks
      (position_id, group_idx, state,
       trigger_price, base_price, amount_pct, pnl_pct)
    VALUES
      ($position_id, $group_idx, $state,
       $trigger_price, $base_price, $amount_pct, $pnl_pct)
  `);

  // Subscribe to all position events (opened, updated, closed, etc.)
  sub = positionEvent$.subscribe({
    next: (ev: PositionEvent) => {
      try {
        // Extract the position state from the event
        const p = ev.position;

        // Upsert the position row
        const result = insertPos.run({
          $order_id: p.orderId,
          $pair: p.pair,
          $token: p.token,
          $token_name: p.tokenName,
          $entry_price: p.entryPriceUsd,
          $entry_cost: p.entryCostUsd,
          $size_sol: p.sizeSol,
          $peak_price: p.peakPriceUsd > 0 ? p.peakPriceUsd : null,
          $close_reason: p.closeReason,
          $profit_pct: p.currentProfitPercent,
          $profit_usd: p.currentProfitUsd,
          $opened_at: p.openedAt,
          // Only set closed_at if this is a close event
          $closed_at: ev.type === "closed" ? p.lastUpdateAt : null,
          $signal_json: p.signal ? JSON.stringify(p.signal) : null,
        });

        // Get the auto-generated row ID for linking tasks
        const positionId = Number(result.lastInsertRowid);

        // Persist TP/SL sub-tasks if this position has any
        if (p.tasks.size > 0) {
          // Wrap all task inserts in a transaction for atomicity and batch performance
          const tx = db.transaction(() => {
            // Iterate over all TP/SL tasks and insert each as a separate row
            for (const task of p.tasks.values()) {
              insertTask.run({
                $position_id: positionId,
                $group_idx: task.groupIdx,
                $state: task.state,
                $trigger_price: task.triggerPriceUsd,
                $base_price: task.basePriceUsd,
                $amount_pct: task.amountPercent,
                $pnl_pct: task.pnlPercent,
              });
            }
          });

          // Execute the transaction — commits all inserts atomically or rolls back on error
          tx();
        }
      } catch (err) {
        // Log persistence errors without crashing the app
        console.error("[trades_repository] Failed to persist position event:", err);
      }
    },
    error: (err) => {
      // Log subscription-level errors
      console.error("[trades_repository] Subscription error:", err);
    },
  });
}

/**
 * Stop persisting events and clean up the subscription
 */
export function stopPersistence(): void {
  // Unsubscribe if active
  sub?.unsubscribe();
  // Clear the reference
  sub = null;
}
