import { BehaviorSubject, Subject } from "rxjs";
import { distinctUntilChanged, shareReplay } from "rxjs/operators";

import { CONFIG } from "../config";
import type { PriceUpdate } from "./types";

/* -------------------------------------------------------------------------- */
/*                              Module Overview                               */
/* -------------------------------------------------------------------------- */

/**
 * DBotX Market Data WebSocket
 *
 * Responsibilities
 * ----------------
 * • Maintain a persistent WebSocket connection.
 * • Automatically reconnect after network failures.
 * • Keep subscribed liquidity pairs synchronized.
 * • Parse incoming market data.
 * • Publish normalized price updates.
 *
 * This module intentionally focuses ONLY on market data.
 *
 * It does NOT:
 *
 * • Execute trades.
 * • Call REST APIs.
 * • Handle simulator endpoints.
 * • Process trade execution events.
 */

/* -------------------------------------------------------------------------- */
/*                               WebSocket Types                              */
/* -------------------------------------------------------------------------- */

/**
 * Pair subscription sent to DBotX.
 */
interface PairSubscription {
  /** Liquidity pair address */
  pair: string;

  /** Token contract address */
  token?: string;
}

/**
 * Subscription payload expected by DBotX.
 */
interface SubscribeRequest {
  method: "subscribe";

  type: "pairsInfo";

  args: {
    pairs: PairSubscription[];
  };
}

/**
 * Raw DBotX market update.
 *
 * The server may return either:
 *
 *  • A single object
 *  • An array of objects
 *
 * Both formats are handled later in the parsing pipeline.
 */
interface RawPriceMessage {
  p?: string;

  pair?: string;

  tp?: number | string;

  tpu?: number | string;

  priceUsd?: number;

  result?: unknown;

  status?: string;
}

/* -------------------------------------------------------------------------- */
/*                              Private Subjects                              */
/* -------------------------------------------------------------------------- */

/**
 * Raw JSON messages received from DBotX.
 *
 * This stream is private because downstream consumers should only
 * work with normalized PriceUpdate objects.
 */
const rawMessageInput$ = new Subject<RawPriceMessage>();

/**
 * Internal connection state.
 */
const connectionStateInput$ = new BehaviorSubject(false);

/**
 * Internal price update publisher.
 */
const priceUpdateInput$ = new Subject<PriceUpdate>();

/* -------------------------------------------------------------------------- */
/*                              Public Streams                                */
/* -------------------------------------------------------------------------- */

/**
 * Emits the current connection state.
 *
 * New subscribers immediately receive the latest value.
 */
export const dataWsConnected$ = connectionStateInput$.pipe(
  distinctUntilChanged(),

  shareReplay({
    bufferSize: 1,
    refCount: true,
  }),
);

/**
 * Emits normalized market price updates.
 *
 * All prices emitted by this observable are already validated and
 * converted into the application's PriceUpdate model.
 */
export const priceUpdate$ = priceUpdateInput$.pipe(
  shareReplay({
    bufferSize: 1,
    refCount: true,
  }),
);

/* -------------------------------------------------------------------------- */
/*                              Runtime State                                 */
/* -------------------------------------------------------------------------- */

/**
 * Active WebSocket connection.
 *
 * Undefined while disconnected.
 */
let websocket: WebSocket | undefined;

/**
 * Pending reconnect timer.
 *
 * Only one reconnect attempt may exist at any time.
 */
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Currently subscribed liquidity pairs.
 *
 * Key
 * ----
 * LP address
 *
 * Value
 * -----
 * Token contract address
 */
const subscribedPairs = new Map<string, string | undefined>();

/* -------------------------------------------------------------------------- */
/*                              Helper Functions                              */
/* -------------------------------------------------------------------------- */

/**
 * Returns true when the socket is connected.
 */
function isConnected(): boolean {
  return websocket?.readyState === WebSocket.OPEN;
}

/**
 * Creates a new authenticated DBotX WebSocket.
 */
function createWebSocket(): WebSocket {
  return new WebSocket(CONFIG.wsUrl, {
    headers: {
      "x-api-key": CONFIG.dbotxApiKey,
    },
  });
}

/**
 * Clears the reconnect timer.
 */
function clearReconnectTimer(): void {
  if (!reconnectTimer) {
    return;
  }

  clearTimeout(reconnectTimer);

  reconnectTimer = undefined;
}

/**
 * Schedules another connection attempt.
 *
 * Multiple reconnect timers are never created.
 */
function scheduleReconnect(): void {
  if (reconnectTimer) {
    return;
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;

    connectDataWs();
  }, CONFIG.wsReconnectDelayMs);
}

import { timer } from "rxjs";
import { filter, switchMap } from "rxjs/operators";

/* -------------------------------------------------------------------------- */
/*                         Subscription Management                            */
/* -------------------------------------------------------------------------- */

/**
 * Builds the subscription request expected by DBotX.
 *
 * Example:
 *
 * {
 *   method: "subscribe",
 *   type: "pairsInfo",
 *   args: {
 *     pairs: [
 *       {
 *         pair: "...",
 *         token: "..."
 *       }
 *     ]
 *   }
 * }
 */
function buildSubscribeRequest(): SubscribeRequest {
  return {
    method: "subscribe",

    type: "pairsInfo",

    args: {
      pairs: [...subscribedPairs.entries()].map(([pair, token]) => ({
        pair,
        token,
      })),
    },
  };
}

/**
 * Sends every active subscription to DBotX.
 *
 * This is automatically called:
 *
 * • After the initial connection
 * • After every reconnect
 * • Whenever a pair is added
 * • Whenever a pair is removed
 */
function synchronizeSubscriptions(): void {
  if (!isConnected()) {
    return;
  }

  if (subscribedPairs.size === 0) {
    return;
  }

  websocket!.send(JSON.stringify(buildSubscribeRequest()));

  console.log(`[DBotX] Synced ${subscribedPairs.size} subscribed pair(s).`);
}

/**
 * Adds a liquidity pair to the subscription list.
 *
 * If the socket is already connected, the updated subscription list
 * is immediately synchronized with DBotX.
 *
 * @param pair Liquidity pair address.
 * @param token Optional token contract address.
 */
export function subscribePair(pair: string, token?: string): void {
  subscribedPairs.set(pair, token);

  synchronizeSubscriptions();
}

/**
 * Removes a liquidity pair from the subscription list.
 *
 * @param pair Liquidity pair address.
 */
export function unsubscribePair(pair: string): void {
  if (!subscribedPairs.delete(pair)) {
    return;
  }

  synchronizeSubscriptions();
}

/**
 * Removes every subscribed pair.
 *
 * Mainly useful during shutdown or testing.
 */
export function clearSubscriptions(): void {
  subscribedPairs.clear();

  synchronizeSubscriptions();
}

// /**
//  * Returns the number of active subscriptions.
//  */
// export function getSubscriptionCount(): number {
//   return subscribedPairs.size;
// }

// /**
//  * Returns true if the pair is currently subscribed.
//  */
// export function isSubscribed(pair: string): boolean {
//   return subscribedPairs.has(pair);
// }

/* -------------------------------------------------------------------------- */
/*                         WebSocket Connection                               */
/* -------------------------------------------------------------------------- */

/**
 * Opens the DBotX market data WebSocket.
 *
 * Safe to call multiple times.
 *
 * If the socket is already connected (or connecting),
 * the call is ignored.
 */
export function connectDataWs(): void {
  if (
    websocket?.readyState === WebSocket.OPEN ||
    websocket?.readyState === WebSocket.CONNECTING
  ) {
    return;
  }

  websocket?.close();

  console.log("[DBotX] Connecting market data WebSocket...");

  websocket = createWebSocket();

  /* ---------------------------------------------------------------------- */
  /* Connected                                                              */
  /* ---------------------------------------------------------------------- */

  websocket.onopen = () => {
    console.log("[DBotX] Market data connected");

    connectionStateInput$.next(true);

    clearReconnectTimer();

    synchronizeSubscriptions();
  };

  /* ---------------------------------------------------------------------- */
  /* Incoming messages                                                      */
  /* ---------------------------------------------------------------------- */

  websocket.onmessage = (event) => {
    if (typeof event.data !== "string") {
      return;
    }

    try {
      rawMessageInput$.next(JSON.parse(event.data) as RawPriceMessage);
    } catch (error) {
      console.warn("[DBotX] Invalid JSON:", error);
    }
  };

  /* ---------------------------------------------------------------------- */
  /* Errors                                                                 */
  /* ---------------------------------------------------------------------- */

  websocket.onerror = (error) => {
    console.error("[DBotX] WebSocket error:", error);

    // Recovery is handled by onclose().
  };

  /* ---------------------------------------------------------------------- */
  /* Closed                                                                 */
  /* ---------------------------------------------------------------------- */

  websocket.onclose = () => {
    console.warn("[DBotX] Market data disconnected");

    websocket = undefined;

    connectionStateInput$.next(false);

    scheduleReconnect();
  };
}

/**
 * Closes the WebSocket connection.
 *
 * Automatic reconnection is cancelled.
 */
export function disconnectDataWs(): void {
  clearReconnectTimer();

  if (!websocket) {
    return;
  }

  console.log("[DBotX] Disconnecting market data...");

  const ws = websocket;

  websocket = undefined;

  ws.close();

  connectionStateInput$.next(false);
}

/* -------------------------------------------------------------------------- */
/*                                Heartbeat                                   */
/* -------------------------------------------------------------------------- */

/**
 * Sends a heartbeat ping while connected.
 *
 * Some proxies and load balancers silently close idle connections.
 * Periodic heartbeats help keep the connection alive.
 */
dataWsConnected$
  .pipe(
    filter(Boolean),

    switchMap(() =>
      timer(CONFIG.wsHeartbeatIntervalMs, CONFIG.wsHeartbeatIntervalMs),
    ),
  )
  .subscribe(() => {
    if (!isConnected()) {
      return;
    }

    try {
      websocket?.ping();
    } catch {
      // Ignore heartbeat failures.
    }
  });

import { from } from "rxjs";
import { concatMap, tap } from "rxjs/operators";

import { acceptedSignal$, expiredPair$ } from "../telegram/telegram_client";

/* -------------------------------------------------------------------------- */
/*                          Market Data Normalization                         */
/* -------------------------------------------------------------------------- */

/**
 * Safely converts a value into a positive number.
 *
 * Returns undefined if the value is invalid.
 */
function parsePositiveNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(number) || number <= 0) {
    return undefined;
  }

  return number;
}

/**
 * Creates a normalized PriceUpdate.
 *
 * Returns undefined if the incoming payload does not
 * contain a valid trading pair or price.
 */
function createPriceUpdate(
  pair: string,
  rawPrice: unknown,
): PriceUpdate | undefined {
  const priceUsd = parsePositiveNumber(rawPrice);

  if (!pair || !priceUsd) {
    return undefined;
  }

  return {
    pair,

    token: subscribedPairs.get(pair) ?? "",

    priceUsd,

    timestamp: Date.now(),
  };
}

/* -------------------------------------------------------------------------- */
/*                           Message Parsing Pipeline                         */
/* -------------------------------------------------------------------------- */

/**
 * Converts every DBotX WebSocket message into one or more
 * normalized PriceUpdate events.
 *
 * Supported message formats:
 *
 * 1.
 *
 * {
 *   result: [
 *     ...
 *   ]
 * }
 *
 * 2.
 *
 * {
 *   result: {
 *     ...
 *   }
 * }
 */
rawMessageInput$
  .pipe(
    /**
     * Ignore acknowledgement packets.
     */
    tap((message) => {
      if (message.status === "ack") {
        return;
      }

      console.debug("[DBotX] Message:", JSON.stringify(message).slice(0, 250));
    }),

    /**
     * Flatten one message into multiple PriceUpdates.
     */
    concatMap((message) => {
      const updates: PriceUpdate[] = [];

      /* ------------------------------------------------------------------ */
      /* Array payload                                                      */
      /* ------------------------------------------------------------------ */

      if (Array.isArray(message.result)) {
        for (const item of message.result as any[]) {
          const pair = String(item.p ?? "");

          const update = createPriceUpdate(pair, item.tpu ?? item.tp);

          if (update) {
            updates.push(update);
          }
        }

        return from(updates);
      }

      /* ------------------------------------------------------------------ */
      /* Single object payload                                              */
      /* ------------------------------------------------------------------ */

      if (message.result && typeof message.result === "object") {
        const result = message.result as Record<string, unknown>;

        const pair = String(message.pair ?? result.pair ?? "");

        const update = createPriceUpdate(
          pair,
          message.priceUsd ?? result.priceUsd ?? result.tpu ?? result.tp,
        );

        if (update) {
          updates.push(update);
        }
      }

      return from(updates);
    }),
  )
  .subscribe((update) => {
    priceUpdateInput$.next(update);
  });

/* -------------------------------------------------------------------------- */
/*                      Telegram Signal Integration                           */
/* -------------------------------------------------------------------------- */

/**
 * Automatically subscribe to every newly accepted signal.
 *
 * The market data stream begins immediately after the
 * Telegram parser accepts a new liquidity pair.
 */
acceptedSignal$.subscribe((signal) => {
  subscribePair(signal.LP!, signal.CA!);
});

/**
 * Remove expired liquidity pairs from the subscription list.
 *
 * Expired pairs no longer consume WebSocket bandwidth.
 */
expiredPair$.subscribe((expiredPairs) => {
  for (const pair of expiredPairs) {
    unsubscribePair(pair);
  }
});

/* -------------------------------------------------------------------------- */
/*                          Manual Price Injection                            */
/* -------------------------------------------------------------------------- */

/**
 * Publishes a synthetic price update.
 *
 * Primarily intended for:
 *
 * • Testing
 * • REST polling fallback
 * • Replay/backtesting
 */
export function pushPriceUpdate(update: PriceUpdate): void {
  priceUpdateInput$.next(update);
}
/* -------------------------------------------------------------------------- */
/*                               Diagnostics                                  */
/* -------------------------------------------------------------------------- */

/**
 * Returns the current WebSocket connection state.
 */
export function isDataWsConnected(): boolean {
  return connectionStateInput$.value;
}

/**
 * Returns the number of currently subscribed liquidity pairs.
 */
export function getSubscriptionCount(): number {
  return subscribedPairs.size;
}

/**
 * Returns every subscribed liquidity pair.
 *
 * A copy is returned so callers cannot mutate the internal state.
 */
export function getSubscribedPairs(): PairSubscription[] {
  return [...subscribedPairs.entries()].map(([pair, token]) => ({
    pair,
    token,
  }));
}

/**
 * Returns true if the specified liquidity pair is currently
 * subscribed to the DBotX market data stream.
 */
export function isSubscribed(pair: string): boolean {
  return subscribedPairs.has(pair);
}

/* -------------------------------------------------------------------------- */
/*                               Shutdown                                     */
/* -------------------------------------------------------------------------- */

/**
 * Completely shuts down the market data module.
 *
 * This function:
 *
 * • Stops automatic reconnect attempts.
 * • Closes the WebSocket.
 * • Clears every subscription.
 * • Resets connection state.
 *
 * Normally called when the application exits.
 */
export function shutdownDataWs(): void {
  console.log("[DBotX] Shutting down market data module...");

  clearReconnectTimer();

  subscribedPairs.clear();

  if (websocket) {
    const ws = websocket;

    websocket = undefined;

    ws.close();
  }

  connectionStateInput$.next(false);
}

/* -------------------------------------------------------------------------- */
/*                            Automatic Startup                               */
/* -------------------------------------------------------------------------- */

/**
 * Start the market data WebSocket immediately when this module
 * is imported.
 *
 * Because connectDataWs() is idempotent, importing this module
 * multiple times will never create multiple connections.
 */
connectDataWs();

/* -------------------------------------------------------------------------- */
/*                              Connection Logs                               */
/* -------------------------------------------------------------------------- */

/**
 * Log connection state transitions.
 */
dataWsConnected$.pipe(filter(Boolean)).subscribe(() => {
  console.log("[DBotX] Market data stream connected");
});

dataWsConnected$.pipe(filter((connected) => !connected)).subscribe(() => {
  console.log("[DBotX] Market data stream disconnected");
});

/* -------------------------------------------------------------------------- */
/*                                Module API                                  */
/* -------------------------------------------------------------------------- */

/**
 * Public API
 *
 * Streams
 * -------
 * • dataWsConnected$
 * • priceUpdate$
 *
 * Connection
 * ----------
 * • connectDataWs()
 * • disconnectDataWs()
 * • shutdownDataWs()
 *
 * Subscription Management
 * -----------------------
 * • subscribePair()
 * • unsubscribePair()
 *
 * Diagnostics
 * -----------
 * • isDataWsConnected()
 * • getSubscriptionCount()
 * • getSubscribedPairs()
 * • isSubscribed()
 *
 * Testing / Replay
 * ----------------
 * • pushPriceUpdate()
 */
