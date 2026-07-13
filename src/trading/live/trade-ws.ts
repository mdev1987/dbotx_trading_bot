import { Subject } from "rxjs";
import { CONFIG } from "../../config";

/* -------------------------------------------------------------------------- */
/*                                   Types                                    */
/* -------------------------------------------------------------------------- */

export interface TradeResultNotification {
  id: string;
  state: "done" | "fail";
  source: string;
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

/* -------------------------------------------------------------------------- */
/*                                  Events                                    */
/* -------------------------------------------------------------------------- */

export const tradeResult$ = new Subject<TradeResultNotification>();

/* -------------------------------------------------------------------------- */
/*                                 Connection                                 */
/* -------------------------------------------------------------------------- */

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let shouldReconnect = true;

const ALL_SUBSCRIBE_TYPES: TradeResultType[] = [
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
  ws.send(
    JSON.stringify({
      method: "subscribeTradeResults",
      tradeTypeFilter: ALL_SUBSCRIBE_TYPES,
    }),
  );
}

function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    try { ws?.ping(); } catch { /* ignore */ }
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
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, CONFIG.wsReconnectDelayMs);
}

/* -------------------------------------------------------------------------- */
/*                               Connect / Disconnect                         */
/* -------------------------------------------------------------------------- */

export function connectTradeWs(): void {
  if (ws) return;

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
    } catch {
      /* ignore malformed messages */
    }
  };

  ws.onclose = () => {
    console.warn("[TradeWS] Disconnected");
    ws = null;
    stopHeartbeat();
    scheduleReconnect();
  };

  ws.onerror = () => {
    /* onclose will fire next */
  };
}

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
