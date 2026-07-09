import { BehaviorSubject, Subject } from "rxjs";
import { distinctUntilChanged, filter, shareReplay } from "rxjs/operators";

import { CONFIG } from "../config";

/* -------------------------------------------------------------------------- */
/*                              Module Overview                               */
/* -------------------------------------------------------------------------- */

/**
 * DBotX Trade Result WebSocket
 *
 * Responsibilities
 * ----------------
 *
 * • Maintain trade notification websocket.
 * • Automatically reconnect after failures.
 * • Receive swap order result notifications.
 * • Normalize trade events.
 * • Publish execution lifecycle events.
 *
 * This module ONLY handles websocket events.
 *
 * It does NOT:
 *
 * • Create orders.
 * • Cancel orders.
 * • Query REST APIs.
 * • Manage positions.
 * • Calculate PnL.
 */

/* -------------------------------------------------------------------------- */
/*                                  Types                                     */
/* -------------------------------------------------------------------------- */

/**
 * Raw DBotX trade notification.
 */
export interface TradeEvent {
  method: "tradeResultNotify";

  result: {
    id?: string;

    state: "done" | "fail" | "expired" | string;

    type?: "buy" | "sell" | string;

    source?: string;

    subSource?:
      | "swap_take_profit"
      | "swap_stop_loss"
      | "swap_trailing_stop"
      | null
      | string;

    txHash?: string;

    txPriceUsd?: number;

    [key: string]: unknown;
  };
}

/* -------------------------------------------------------------------------- */
/*                              Internal Streams                              */
/* -------------------------------------------------------------------------- */

/**
 * Raw connection state.
 */
const connectionStateInput$ = new BehaviorSubject(false);

/**
 * Raw trade event publisher.
 */
const tradeEventInput$ = new Subject<TradeEvent>();

/* -------------------------------------------------------------------------- */
/*                              Public Streams                                */
/* -------------------------------------------------------------------------- */

/**
 * Trade websocket connection state.
 */
export const tradeWsConnected$ = connectionStateInput$.pipe(
  distinctUntilChanged(),

  shareReplay({
    bufferSize: 1,
    refCount: true,
  }),
);

/**
 * Every valid DBotX trade event.
 */
export const tradeEvent$ = tradeEventInput$.pipe(
  shareReplay({
    bufferSize: 1,
    refCount: true,
  }),
);

/* -------------------------------------------------------------------------- */
/*                           Filtered Trade Streams                           */
/* -------------------------------------------------------------------------- */

/**
 * Successful buy orders.
 */
export const buySuccess$ = tradeEvent$.pipe(
  filter(
    (event) =>
      event.result.state === "done" &&
      event.result.type === "buy" &&
      event.result.source === "swap_order",
  ),
);

/**
 * Successful normal sell orders.
 */
export const sellSuccess$ = tradeEvent$.pipe(
  filter(
    (event) =>
      event.result.state === "done" &&
      event.result.type === "sell" &&
      event.result.source === "swap_order" &&
      event.result.subSource == null,
  ),
);

/**
 * Take profit executions.
 */
export const takeProfitSuccess$ = tradeEvent$.pipe(
  filter(
    (event) =>
      event.result.state === "done" &&
      event.result.subSource === "swap_take_profit",
  ),
);

/**
 * Stop loss executions.
 */
export const stopLossSuccess$ = tradeEvent$.pipe(
  filter(
    (event) =>
      event.result.state === "done" &&
      event.result.subSource === "swap_stop_loss",
  ),
);

/**
 * Trailing stop executions.
 */
export const trailingStopSuccess$ = tradeEvent$.pipe(
  filter(
    (event) =>
      event.result.state === "done" &&
      event.result.subSource === "swap_trailing_stop",
  ),
);

/**
 * Failed or expired orders.
 */
export const tradeFailed$ = tradeEvent$.pipe(
  filter(
    (event) =>
      event.result.state === "fail" || event.result.state === "expired",
  ),
);

/* -------------------------------------------------------------------------- */
/*                              Runtime State                                 */
/* -------------------------------------------------------------------------- */

/**
 * Active websocket.
 */
let websocket: WebSocket | undefined;

/**
 * Reconnect timer.
 */
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

/* -------------------------------------------------------------------------- */
/*                              Helpers                                      */
/* -------------------------------------------------------------------------- */

/**
 * Returns true if websocket is connected.
 */
function isConnected(): boolean {
  return websocket?.readyState === WebSocket.OPEN;
}

/**
 * Creates authenticated DBotX trade websocket.
 */
function createWebSocket(): WebSocket {
  return new WebSocket(CONFIG.tradeWsUrl, {
    headers: {
      "x-api-key": CONFIG.dbotxApiKey,
    },
  });
}

/**
 * Cancel reconnect timer.
 */
function clearReconnectTimer(): void {
  if (!reconnectTimer) {
    return;
  }

  clearTimeout(reconnectTimer);

  reconnectTimer = undefined;
}

/**
 * Schedule reconnect.
 */
function scheduleReconnect(): void {
  if (reconnectTimer) {
    return;
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;

    connectTradeWs();
  }, CONFIG.wsReconnectDelayMs);
}

/**
 * Validate incoming websocket payload.
 */
function isTradeEvent(value: unknown): value is TradeEvent {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const event = value as Partial<TradeEvent>;

  return (
    event.method === "tradeResultNotify" &&
    typeof event.result === "object" &&
    event.result !== null
  );
}

/* -------------------------------------------------------------------------- */
/*                          WebSocket Connection                              */
/* -------------------------------------------------------------------------- */

/**
 * Connect trade result websocket.
 */
export function connectTradeWs(): void {
  /**
   * Trade websocket is only needed in live mode.
   */
  if (!CONFIG.liveMode) {
    console.log("[DBotX] Trade WS disabled (simulation mode)");

    return;
  }

  if (
    websocket?.readyState === WebSocket.OPEN ||
    websocket?.readyState === WebSocket.CONNECTING
  ) {
    return;
  }

  websocket?.close();

  console.log("[DBotX] Connecting trade websocket...");

  websocket = createWebSocket();

  websocket.onopen = () => {
    console.log("[DBotX] Trade websocket connected");

    connectionStateInput$.next(true);

    clearReconnectTimer();
  };

  websocket.onmessage = (event) => {
    if (typeof event.data !== "string") {
      return;
    }

    try {
      const message = JSON.parse(event.data);

      if (isTradeEvent(message)) {
        tradeEventInput$.next(message);
      }
    } catch {
      console.warn("[DBotX] Invalid trade websocket JSON");
    }
  };

  websocket.onerror = () => {
    /**
     * Recovery happens in onclose.
     */
  };

  websocket.onclose = () => {
    console.warn("[DBotX] Trade websocket disconnected");

    websocket = undefined;

    connectionStateInput$.next(false);

    if (CONFIG.liveMode) {
      scheduleReconnect();
    }
  };
}

/**
 * Disconnect websocket.
 */
export function disconnectTradeWs(): void {
  clearReconnectTimer();

  if (!websocket) {
    return;
  }

  console.log("[DBotX] Disconnecting trade websocket...");

  const ws = websocket;

  websocket = undefined;

  ws.close();

  connectionStateInput$.next(false);
}

/* -------------------------------------------------------------------------- */
/*                              Diagnostics                                   */
/* -------------------------------------------------------------------------- */

/**
 * Current websocket state.
 */
export function isTradeWsConnected(): boolean {
  return connectionStateInput$.value;
}

/* -------------------------------------------------------------------------- */
/*                               Shutdown                                     */
/* -------------------------------------------------------------------------- */

/**
 * Complete shutdown.
 */
export function shutdownTradeWs(): void {
  console.log("[DBotX] Shutting down trade websocket...");

  clearReconnectTimer();

  if (websocket) {
    const ws = websocket;

    websocket = undefined;

    ws.close();
  }

  connectionStateInput$.next(false);
}

/* -------------------------------------------------------------------------- */
/*                          Automatic Startup                                 */
/* -------------------------------------------------------------------------- */

/**
 * Start automatically in live mode.
 */
if (CONFIG.liveMode) {
  connectTradeWs();
}

/* -------------------------------------------------------------------------- */
/*                              Diagnostics Logs                              */
/* -------------------------------------------------------------------------- */

tradeWsConnected$.pipe(filter(Boolean)).subscribe(() => {
  console.log("[DBotX] Trade stream connected");
});

tradeWsConnected$.pipe(filter((value) => !value)).subscribe(() => {
  console.log("[DBotX] Trade stream disconnected");
});
