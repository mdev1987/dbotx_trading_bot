/**
 * analytics/trades_repository.ts
 *
 * Persists position lifecycle events to SQLite.
 *
 * Subscribes to positionEvent$, upserts the position row and
 * its TP/SL tasks on every event.  Call startPersistence()
 * once during app startup; call stopPersistence() to tear down.
 */

import { Subscription } from "rxjs";
import { getDb } from "./sqlite";
import { positionEvent$ } from "../simulator/position_manager";
import type { PositionEvent } from "../simulator/position_manager";

let sub: Subscription | null = null;

export function startPersistence(): void {
  if (sub) return;

  const db = getDb();

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

  const insertTask = db.prepare(`
    INSERT INTO tasks
      (position_id, group_idx, state,
       trigger_price, base_price, amount_pct, pnl_pct)
    VALUES
      ($position_id, $group_idx, $state,
       $trigger_price, $base_price, $amount_pct, $pnl_pct)
  `);

  sub = positionEvent$.subscribe({
    next: (ev: PositionEvent) => {
      try {
        const p = ev.position;

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
          $closed_at: ev.type === "closed" ? p.lastUpdateAt : null,
          $signal_json: p.signal ? JSON.stringify(p.signal) : null,
        });

        const positionId = Number(result.lastInsertRowid);

        if (p.tasks.size > 0) {
          const tx = db.transaction(() => {
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

          tx();
        }
      } catch (err) {
        console.error("[trades_repository] Failed to persist position event:", err);
      }
    },
    error: (err) => {
      console.error("[trades_repository] Subscription error:", err);
    },
  });
}

export function stopPersistence(): void {
  sub?.unsubscribe();
  sub = null;
}
