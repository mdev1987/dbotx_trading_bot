import { Subscription } from "rxjs";
import { CONFIG } from "../../config";
import { botHttp } from "../http";
import {
  getStoreOrders,
  closePosition as storeClosePosition,
  type StoredOrder,
} from "./store";
import { tradeResult$, type TradeResultNotification } from "./trade-ws";
import { removePosition } from "../../strategy/positions_store";
import { untrackToken } from "../../data_stream/price_engine";
import { sendTelegram } from "../../telegram/telegram_bot";

/* -------------------------------------------------------------------------- */
/*                                 State                                      */
/* -------------------------------------------------------------------------- */

let unsub: Subscription | null = null;
let reconcileTimer: ReturnType<typeof setInterval> | null = null;

/* -------------------------------------------------------------------------- */
/*                              Notify on exit                                */
/* -------------------------------------------------------------------------- */

function exitLabel(type: string): string {
  if (type.includes("take_profit")) return "Take Profit";
  if (type.includes("stop_loss")) return "Stop Loss";
  if (type.includes("trailing_stop")) return "Trailing Stop";
  return "Sell";
}

async function notifyTrade(
  order: StoredOrder | undefined,
  notif: TradeResultNotification,
): Promise<void> {
  const name = order?.tokenName ?? notif.symbol ?? notif.token.slice(0, 8);
  const isSuccess = notif.state === "done";
  const emoji = notif.type === "buy" ? "🟢" : isSuccess ? "🟢" : "🔴";
  const label = notif.type === "buy" ? "Buy" : exitLabel(notif.source);

  const lines = [
    `${emoji} **${label} ${isSuccess ? "Success" : "Failed"}**`,
    `━━━━━━━━━━━━━━━━━━━`,
    `🔖 Token: \`${name}\``,
  ];

  if (notif.priceUsd) {
    lines.push(`💵 Price: \`$${notif.priceUsd}\``);
  }

  if (!isSuccess && notif.errorMessage) {
    lines.push(`❌ Error: \`${notif.errorMessage}\``);
  }

  if (isSuccess && notif.hash) {
    lines.push(`🔗 Tx: \`${notif.hash.slice(0, 16)}…\``);
  }

  sendTelegram(lines.join("\n"));
}

/* -------------------------------------------------------------------------- */
/*                          Handle WS notifications                           */
/* -------------------------------------------------------------------------- */

function handleTradeResult(notif: TradeResultNotification): void {
  const orders = getStoreOrders();
  const order = orders.find((o) => o.id === notif.id || o.pair === notif.pair);

  if (!order) {
    // Unknown order — notify anyway if it's a sell exit
    if (notif.type === "sell") {
      notifyTrade(undefined, notif);
    }
    return;
  }

  notifyTrade(order, notif);

  if (notif.type === "sell" && notif.state === "done") {
    storeClosePosition(order.pair, notif.priceUsd ?? 0, exitLabel(notif.source));
    removePosition(order.pair, notif.priceUsd, undefined as any);
    untrackToken(order.token);
    console.log(`[LiveMonitor] Exit done for ${order.tokenName}: $${notif.priceUsd}`);
  }
}

/* -------------------------------------------------------------------------- */
/*                     Periodic reconciliation (fallback)                     */
/* -------------------------------------------------------------------------- */

async function reconcile(): Promise<void> {
  const openPositions = getStoreOrders().filter((o) => o.type === "buy");
  if (openPositions.length === 0) return;

  console.log("[LiveMonitor] Reconciliation check...");
  for (const order of openPositions) {
    try {
      const response = await botHttp.get<{
        err: boolean;
        res: { state: string; txPriceUsd?: number }[];
      }>(`/automation/swap_orders?ids=${order.id}`);

      if (response.err || !response.res.length) continue;
      const task = response.res[0];
      if (!task) continue;

      if (task.state === "done" || task.state === "fail" || task.state === "expired") {
        console.log(`[LiveMonitor] Reconcile: ${order.tokenName} state=${task.state}`);
      }
    } catch (err) {
      console.warn(`[LiveMonitor] Reconciliation failed for ${order.tokenName}:`, err);
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                              Lifecycle                                     */
/* -------------------------------------------------------------------------- */

export function startLiveMonitor(): void {
  if (unsub) return;

  unsub = tradeResult$.subscribe(handleTradeResult);

  // Lightweight reconciliation as WS fallback
  reconcileTimer = setInterval(reconcile, CONFIG.liveReconcileIntervalMs);

  console.log("[LiveMonitor] Started (WS + 5min reconciliation)");
}

export function stopLiveMonitor(): void {
  if (unsub) {
    unsub.unsubscribe();
    unsub = null;
  }
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
  console.log("[LiveMonitor] Stopped");
}
