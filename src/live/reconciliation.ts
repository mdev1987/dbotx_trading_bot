import { timer, Subscription } from "rxjs";
import { tap } from "rxjs/operators";
import { LIVE_CONFIG } from "./config";
import { getAllOrderIds, loadAllPositions } from "./persistence";
import { querySwapOrders } from "./fast_buy_sell";

export function startReconciliation(): Subscription {
  return timer(LIVE_CONFIG.reconciliationIntervalMs, LIVE_CONFIG.reconciliationIntervalMs)
    .pipe(
      tap(async () => {
        try {
          await reconcile();
        } catch (err) {
          console.error("[live/reconciliation] Failed:", err);
        }
      }),
    )
    .subscribe();
}

async function reconcile(): Promise<void> {
  const orderIds = getAllOrderIds();

  if (orderIds.length === 0) return;

  let exchangeOrders;
  try {
    exchangeOrders = await querySwapOrders(orderIds);
  } catch (err) {
    console.warn("[live/reconciliation] Exchange query failed:", err);
    return;
  }

  const exchangeMap = new Map(exchangeOrders.map((o) => [o.id, o]));

  for (const orderId of orderIds) {
    // Paper positions have no real exchange order — skip reconciliation
    if (orderId.startsWith("paper_")) continue;

    const exOrder = exchangeMap.get(orderId);
    if (!exOrder) {
      console.warn(`[live/reconciliation] Order ${orderId} not found on exchange`);
      continue;
    }

    if (exOrder.state === "done" || exOrder.state === "fail" || exOrder.state === "expired") {
      console.log(
        `[live/reconciliation] Order ${orderId} is ${exOrder.state} on exchange — may need local update`,
      );
    }
  }
}
