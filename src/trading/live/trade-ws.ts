import { Subject, Subscription } from "rxjs";
import { CONFIG } from "../../config";
import { botHttp } from "../http";
import { getStoreOrders, closePosition as storeClosePosition, type StoredOrder } from "./store";
import { hasPosition, removePosition } from "../../strategy/positions_store";
import { PositionExitReason } from "../../strategy/types";
import { untrackToken } from "../../data_stream/price_engine";
import { sendTelegram } from "../../telegram/telegram_bot";

export interface TradeResultNotification {
  id: string;
  state: "done" | "fail";
  source: string;
  subSource?: string | null;
  chain: string;
  type: "buy" | "sell";
  token: string;
  pair: string;
  symbol: string;
  priceUsd?: number;
  hash?: string;
  errorCode?: string;
  errorMessage?: string;
  send?: { amount: string };
  receive?: { amount: string };
}

/** Stream of trade-result notifications from the WebSocket. */
export const tradeResult$ = new Subject<TradeResultNotification>();

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let shouldReconnect = true;
let reconnectAttempt = 0;

const INITIAL_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;
const MAX_RECONNECT_ATTEMPTS = 50;

const ALL_SUBSCRIBE_TYPES: string[] = [
  "swap_buy_success",
  "swap_buy_fail",
  "swap_sell_success",
  "swap_sell_fail",
  "swap_take_profit_success",
  "swap_take_profit_fail",
  "swap_stop_loss_success",
  "swap_stop_loss_fail",
  "swap_trailing_stop_success",
  "swap_trailing_stop_fail",
];

function sendSubscribe(): void {
  if (ws?.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ method: "subscribeTradeResults", tradeTypeFilter: ALL_SUBSCRIBE_TYPES }));
}

function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    try { ws?.ping(); } catch (err) { console.warn("[TradeWS] Heartbeat ping failed:", err); }
  }, CONFIG.tradeWsHeartbeatIntervalMs);
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function scheduleReconnect(): void {
  if (!shouldReconnect) return;
  if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
    console.error(`[TradeWS] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached — giving up`);
    shouldReconnect = false;
    return;
  }
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const delay = Math.min(INITIAL_RECONNECT_MS * 2 ** reconnectAttempt, MAX_RECONNECT_MS);
  const jitter = delay * 0.2 * Math.random();
  reconnectAttempt++;
  reconnectTimer = setTimeout(connectTradeWs, delay + jitter);
}

/** Open the trade-results WebSocket connection and subscribe. */
export function connectTradeWs(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  shouldReconnect = true;

  try {
    ws = new WebSocket(CONFIG.tradeWsUrl, {
      headers: { "x-api-key": CONFIG.dbotxApiKey },
    });
  } catch (err) {
    console.error("[TradeWS] Connection failed:", err);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log("[TradeWS] Connected");
    reconnectAttempt = 0;
    sendSubscribe();
    startHeartbeat();
  };

  ws.onmessage = (event: MessageEvent) => {
    try {
      const msg = JSON.parse(event.data as string);
      if (msg.method === "subscribeResponse") {
        console.log("[TradeWS] Subscribed to trade results");
        return;
      }
      if (msg.method === "tradeResultNotify" && msg.result) {
        tradeResult$.next(msg.result as TradeResultNotification);
      }
    } catch (err) {
      console.warn("[TradeWS] Failed to parse message:", err);
    }
  };

  ws.onclose = () => {
    console.warn("[TradeWS] Disconnected");
    ws = null;
    stopHeartbeat();
    scheduleReconnect();
  };

  ws.onerror = () => { /* onclose will fire next */ };
}

/** Close WebSocket and disable auto-reconnect. */
export function disconnectTradeWs(): void {
  shouldReconnect = false;
  stopHeartbeat();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
}

let monitorSub: Subscription | null = null;
let reconcileTimer: ReturnType<typeof setInterval> | null = null;

/** Map an event source string to a human-readable exit label. */
export function exitLabel(type: string): string {
  if (type.includes("take_profit")) return "Take Profit";
  if (type.includes("stop_loss")) return "Stop Loss";
  if (type.includes("trailing_stop")) return "Trailing Stop";
  return "Sell";
}

/** Derive a PositionExitReason from a trade result notification's subSource. */
export function toExitReason(notif: TradeResultNotification): PositionExitReason | undefined {
  if (notif.subSource?.includes("take_profit")) return PositionExitReason.TakeProfit;
  if (notif.subSource?.includes("stop_loss")) return PositionExitReason.StopLoss;
  if (notif.subSource?.includes("trailing_stop")) return PositionExitReason.TrailingStop;
  return undefined;
}

async function notifyTrade(order: StoredOrder | undefined, notif: TradeResultNotification): Promise<void> {
  const name = order?.tokenName ?? notif.symbol ?? notif.token?.slice(0, 8) ?? "?";
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

/** Process an incoming trade result: notify Telegram and close position on sell-done. */
export function handleTradeResult(notif: TradeResultNotification): void {
  const orders = getStoreOrders();
  const order = orders.find((o) => o.id === notif.id || o.pair === notif.pair);

  if (!order) {
    if (notif.type === "sell") notifyTrade(undefined, notif).catch(() => {});
    return;
  }

  notifyTrade(order, notif).catch(() => {});

  if (notif.type === "sell" && notif.state === "done") {
    if (hasPosition(order.pair)) {
      storeClosePosition(order.pair, notif.priceUsd ?? 0, exitLabel(notif.source));
      removePosition(order.pair, notif.priceUsd, toExitReason(notif));
      untrackToken(order.token);
      console.log(`[LiveMonitor] Exit done for ${order.tokenName}: $${notif.priceUsd}`);
    }
  }
}

async function reconcile(): Promise<void> {
  const openBuyOrders = getStoreOrders().filter((o) => o.type === "buy");
  if (openBuyOrders.length === 0) return;

  console.log("[LiveMonitor] Reconciliation check...");
  for (const order of openBuyOrders) {
    try {
      const response = await botHttp.get<{
        err: boolean;
        res: { state: string; txPriceUsd?: number }[];
      }>(`/automation/swap_orders?ids=${order.id}`);

      if (response.err || !response.res.length) continue;
      const task = response.res[0];
      if (!task) continue;

      if (task.state === "done" || task.state === "fail" || task.state === "expired") {
        if (hasPosition(order.pair)) {
          console.log(`[LiveMonitor] Reconcile: closing stale position ${order.tokenName} state=${task.state}`);
          storeClosePosition(order.pair, task.txPriceUsd ?? 0, "Reconciliation");
          removePosition(order.pair, task.txPriceUsd, PositionExitReason.Expired);
          untrackToken(order.token);
        }
      }
    } catch (err) {
      console.warn(`[LiveMonitor] Reconciliation failed for ${order.tokenName}:`, err);
    }
  }
}

/** Subscribe to trade results and start periodic reconciliation. */
export function startLiveMonitor(): void {
  if (monitorSub) return;
  monitorSub = tradeResult$.subscribe(handleTradeResult);
  reconcileTimer = setInterval(reconcile, CONFIG.liveReconcileIntervalMs);
  console.log("[LiveMonitor] Started");
}

/** Unsubscribe from trade results and stop reconciliation. */
export function stopLiveMonitor(): void {
  if (monitorSub) {
    monitorSub.unsubscribe();
    monitorSub = null;
  }
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
  console.log("[LiveMonitor] Stopped");
}
