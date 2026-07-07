/**
 * WebSocket client for live trading trade results.
 *
 * Connects to wss://api-bot-v1.dbotx.com/trade/ws/ and subscribes to trade
 * result notifications (swap_buy_success, swap_sell_success, swap_take_profit_*,
 * swap_stop_loss_*, swap_trailing_stop_*).
 *
 * Provides a reactive RxJS stream of TradeResultEvent objects.
 *
 * Heartbeat is sent every 30-55 seconds (configured via WS_HEARTBEAT_INTERVAL_MS).
 * Auto-reconnect with exponential backoff is implemented.
 */
import { Subject, Observable, timer, merge } from "rxjs";
import { filter, map, share, tap } from "rxjs/operators";
import { LIVE_CONFIG } from "./config";
import { markWsMessage } from "./watchdog";
import type { TradeResultEvent, TradeResultSource, TradeResultSubSource } from "./types";

// ---------------------------------------------------------------------------
// Public streams
// ---------------------------------------------------------------------------

/**
 * Raw stream of all trade result events from the WS.
 * Emits a parsed TradeResultEvent for every incoming message.
 */
export const tradeResultEvent$ = new Subject<TradeResultEvent>();

/**
 * Filtered stream for BUY success events only.
 */
export const buySuccessEvent$: Observable<TradeResultEvent> = tradeResultEvent$.pipe(
  filter((e) => {
    const r = e.result;
    return r.state === "done" && r.type === "buy" && r.source === "swap_order";
  }),
  share(),
);

/**
 * Filtered stream for SELL success events (direct sell + TP + SL + trailing).
 */
export const sellSuccessEvent$: Observable<TradeResultEvent> = tradeResultEvent$.pipe(
  filter((e) => {
    const r = e.result;
    return (
      r.state === "done" &&
      r.type === "sell" &&
      r.source === "swap_order" &&
      r.subSource === null
    );
  }),
  share(),
);

/**
 * Filtered stream for take-profit success events.
 */
export const takeProfitSuccessEvent$: Observable<TradeResultEvent> = tradeResultEvent$.pipe(
  filter((e) => {
    const r = e.result;
    return (
      r.state === "done" &&
      r.subSource === "swap_take_profit"
    );
  }),
  share(),
);

/**
 * Filtered stream for stop-loss success events.
 */
export const stopLossSuccessEvent$: Observable<TradeResultEvent> = tradeResultEvent$.pipe(
  filter((e) => {
    const r = e.result;
    return (
      r.state === "done" &&
      r.subSource === "swap_stop_loss"
    );
  }),
  share(),
);

/**
 * Filtered stream for trailing stop success events.
 */
export const trailingStopSuccessEvent$: Observable<TradeResultEvent> = tradeResultEvent$.pipe(
  filter((e) => {
    const r = e.result;
    return (
      r.state === "done" &&
      r.subSource === "swap_trailing_stop"
    );
  }),
  share(),
);

/**
 * Filtered stream for ALL failure events (buy/sell/tp/sl/trailing).
 */
export const tradeFailEvent$: Observable<TradeResultEvent> = tradeResultEvent$.pipe(
  filter((e) => e.result.state === "fail"),
  share(),
);

// ---------------------------------------------------------------------------
// WS connection management
// ---------------------------------------------------------------------------

/** Internal WebSocket instance. */
let ws: WebSocket | null = null;

/** Flag to prevent reconnect after intentional close. */
let intentionalClose = false;

/** Counter for exponential backoff on reconnect. */
let reconnectAttempt = 0;

/** Consecutive WS disconnect counter for circuit breaker. */
let _wsDisconnectCount = 0;

/** Get the current WS disconnect count. */
export function wsDisconnectCount(): number {
  return _wsDisconnectCount;
}

/** Reset the WS disconnect counter (called on successful connect). */
export function resetWsDisconnectCount(): void {
  _wsDisconnectCount = 0;
}

/**
 * Timer handle for the heartbeat interval.
 */
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the WebSocket connection and subscribe to trade results.
 *
 * The WS is authenticated via X-API-KEY in the connection headers.
 * After opening, it sends a subscribeTradeResults message.
 *
 * @returns A promise that resolves when the connection is established
 *          and the subscription is acknowledged.
 */
export function connectTradeResultsWs(): Promise<void> {
  intentionalClose = false;
  reconnectAttempt = 0;

  return new Promise((resolve, reject) => {
    try {
      ws = new WebSocket(LIVE_CONFIG.tradeWsUrl, {
        headers: {
          "x-api-key": LIVE_CONFIG.dbotxApiKey,
        },
      });

      ws.addEventListener("open", () => {
        console.log("[live/ws] Trade results WS connected");
        _wsDisconnectCount = 0;

        /** Send the subscription message. */
        const subscribeMsg = {
          method: "subscribeTradeResults",
          tradeTypeFilter: [
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
          ],
        };

        ws!.send(JSON.stringify(subscribeMsg));

        /** Start heartbeat pings. */
        startHeartbeat();

        /** Resolve the promise once the subscription is sent. */
        resolve();
      });

      ws.addEventListener("message", (event: MessageEvent) => {
        try {
          const rawData = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer);
          const data = JSON.parse(rawData) as TradeResultEvent | SubscribeResponse | RpcResponse;

          /** Check if this is the subscription acknowledgment. */
          if (isSubscribeResponse(data)) {
            console.log("[live/ws] Trade results subscription confirmed:", data.result.message);
            return;
          }

          /** Check if this is an RPC response (not a notification). */
          if (isRpcResponse(data)) {
            /** RPC responses are request/response — we don't expect these in normal flow. */
            return;
          }

          /** It is a trade result notification. */
          if (data.method === "tradeResultNotify") {
            markWsMessage();
            tradeResultEvent$.next(data as TradeResultEvent);
          }
        } catch (err) {
          console.error("[live/ws] Failed to parse WS message:", err);
        }
      });

      ws.addEventListener("error", (err: Event) => {
        console.error("[live/ws] WS error:", err);
        reject(err);
      });

      ws.addEventListener("close", (event: CloseEvent) => {
        console.warn(`[live/ws] WS closed: code=${event.code} reason=${event.reason}`);
        stopHeartbeat();

        if (!intentionalClose) {
          _wsDisconnectCount++;
          console.warn(
            `[live/ws] WS disconnect count: ${_wsDisconnectCount}/${LIVE_CONFIG.maxWsDisconnects}`,
          );

          if (_wsDisconnectCount >= LIVE_CONFIG.maxWsDisconnects) {
            console.error(
              `[live/ws] ${_wsDisconnectCount} disconnects — enabling panic`,
            );
            import("./panic").then((m) => m.enablePanic());
          }

          scheduleReconnect();
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Gracefully close the WebSocket connection.
 */
export function disconnectTradeResultsWs(): void {
  intentionalClose = true;
  stopHeartbeat();
  if (ws) {
    ws.close(1000, "Client disconnect");
    ws = null;
  }
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

/**
 * Start sending periodic pings to keep the WS connection alive.
 * The server requires a heartbeat at least once per 60 seconds;
 * we use the configured interval (default 30 s).
 */
function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, LIVE_CONFIG.wsHeartbeatIntervalMs);
}

/**
 * Stop the heartbeat timer.
 */
function stopHeartbeat(): void {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Reconnect
// ---------------------------------------------------------------------------

/**
 * Schedule a reconnection attempt with exponential backoff.
 */
function scheduleReconnect(): void {
  const delay = Math.min(
    LIVE_CONFIG.wsReconnectDelayMs * 2 ** reconnectAttempt,
    60_000, // cap at 60 seconds
  );

  reconnectAttempt++;

  console.log(`[live/ws] Reconnecting in ${delay}ms (attempt ${reconnectAttempt})`);

  setTimeout(() => {
    if (!intentionalClose) {
      connectTradeResultsWs().catch((err) => {
        console.error("[live/ws] Reconnect failed:", err);
      });
    }
  }, delay);
}

// ---------------------------------------------------------------------------
// Response type guards
// ---------------------------------------------------------------------------

/**
 * Shape of the subscribe acknowledgment response.
 */
interface SubscribeResponse {
  method: "subscribeResponse";
  result: {
    message: string;
  };
}

/**
 * Shape of an RPC-style response.
 */
interface RpcResponse {
  method: "rpcResponse";
  id: number;
  result: {
    err: boolean;
    res: unknown;
  };
}

/**
 * Check if a parsed WS message is the subscribe acknowledgment.
 */
function isSubscribeResponse(data: unknown): data is SubscribeResponse {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as Record<string, unknown>).method === "subscribeResponse"
  );
}

/**
 * Check if a parsed WS message is an RPC response.
 */
function isRpcResponse(data: unknown): data is RpcResponse {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as Record<string, unknown>).method === "rpcResponse"
  );
}
