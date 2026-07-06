/**
 * Reactive DBotX WebSocket client.
 *
 * Manages the WebSocket connection lifecycle (connect / disconnect / reconnect),
 * pair subscriptions (subscribe / unsubscribe), and exposes strongly-typed RxJS
 * streams for market data updates, prices, market cap, liquidity, and holders.
 *
 * Uses a BehaviorSubject to track the current WebSocket instance and RxJS pipes
 * to transform raw message events into typed {@link PairUpdate} objects.
 */

import { BehaviorSubject, fromEvent, interval } from "rxjs";
import {
  filter,
  map,
  share,
  shareReplay,
  switchMap,
  tap,
} from "rxjs/operators";

import { CONFIG } from "../config";

import {
  acceptedSignal$,
  expiredPair$,
  latestSignalState,
} from "../telegram/signals_stream";

import type { PairUpdate, WsRawMessage } from "./types";

// -----------------------------------------------------------------------------
// Internal state
// -----------------------------------------------------------------------------

/** Holds the current WebSocket instance (null when disconnected) */
const wsSubject = new BehaviorSubject<WebSocket | null>(null);

/** Timer handle for the scheduled reconnection attempt */
let reconnectTimer: NodeJS.Timeout | null = null;
/** Timestamp (ms) of the last reconnect log message — used for throttling */
let lastDisconnectLog = 0;

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

/**
 * Retrieve the current WebSocket handle only if it is in the OPEN state.
 *
 * @returns The open WebSocket, or null if not connected / not ready.
 */
function getSocket(): WebSocket | null {
  // Read the current value from the BehaviorSubject
  const ws = wsSubject.value;

  // Guard: no socket instance at all
  if (!ws) return null;
  // Guard: socket exists but is not ready for communication
  if (ws.readyState !== WebSocket.OPEN) return null;

  return ws;
}

/**
 * Serialise and send a JSON payload over the open WebSocket connection.
 *
 * @param payload - The data to send (will be JSON-stringified).
 * @returns `true` if the message was sent, `false` if the socket was not open.
 */
function send(payload: unknown): boolean {
  // Get the current open socket (returns null if not connected)
  const ws = getSocket();

  // Guard: skip send if the socket is unavailable
  if (!ws) {
    return false;
  }

  // Serialise and transmit
  ws.send(JSON.stringify(payload));
  return true;
}

/**
 * Subscribe to real-time market data for a given trading pair.
 *
 * @param pair  - LP address / pair identifier to subscribe to.
 * @param token - Optional token contract address (required by some API versions).
 * @returns `true` if the subscription request was sent, `false` otherwise.
 */
function subscribePair(pair: string, token?: string): boolean {
  return send({
    method: "subscribe",
    type: "pairInfo",
    args: {
      pair,
      // Only include token when it is provided (avoids sending null / undefined)
      ...(token ? { token } : {}),
    },
  });
}

/**
 * Unsubscribe from real-time market data for a given trading pair.
 *
 * @param pair - LP address / pair identifier to unsubscribe from.
 * @returns `true` if the unsubscription request was sent, `false` otherwise.
 */
function unsubscribePair(pair: string): boolean {
  return send({
    method: "unsubscribe",
    type: "pairInfo",
    args: {
      pair,
    },
  });
}

/**
 * Safely coerce an unknown value into a finite number (or undefined).
 *
 * Handles the case where the API may return numeric values as strings.
 *
 * @param value - The raw value from the API (string, number, null, etc.).
 * @returns The parsed finite number, or `undefined` if the value is null,
 *          undefined, or cannot be parsed into a finite number.
 */
function parseNumber(value: unknown): number | undefined {
  // Guard: null / undefined are explicitly treated as "not available"
  if (value === undefined || value === null) {
    return undefined;
  }

  // Coerce to number (Number("123") → 123, Number("abc") → NaN)
  const parsed = Number(value);

  // Only return finite numbers; reject NaN, Infinity, -Infinity
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Log a disconnect message, throttled to avoid flooding the console.
 *
 * Only logs if at least {@link CONFIG.wsDisconnectLogThrottleMs} ms have
 * elapsed since the last disconnect log.
 */
function logReconnect(): void {
  const now = Date.now();

  // Guard: skip logging if we are still within the throttle window
  if (now - lastDisconnectLog < CONFIG.wsDisconnectLogThrottleMs) {
    return;
  }

  // Update the throttle timestamp so subsequent calls are also rate-limited
  lastDisconnectLog = now;

  console.log(
    `[DBotX] Disconnected - reconnecting in ${CONFIG.wsReconnectDelayMs}ms`,
  );
}

/**
 * Schedule a reconnection attempt after the configured delay.
 *
 * Includes a guard that clears any previously scheduled timer
 * to prevent stacking multiple reconnect attempts.
 */
function scheduleReconnect(): void {
  // Guard: if the socket already reports as open, do not schedule reconnect
  // (prevents race conditions where close and open events arrive out of order)
  const currentWs = wsSubject.value;
  if (currentWs && currentWs.readyState === WebSocket.OPEN) {
    return;
  }

  // Guard: cancel any previously scheduled timer so we never stack timeouts
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  // Schedule a single reconnect attempt after the configured delay
  reconnectTimer = setTimeout(connect, CONFIG.wsReconnectDelayMs);
}

// -----------------------------------------------------------------------------
// Connection
// -----------------------------------------------------------------------------

/**
 * Open a new WebSocket connection to the DBotX API.
 *
 * Registers event listeners for open, close, and error events.
 * On open: updates the wsSubject so downstream streams start emitting.
 * On close: clears the subject, logs (throttled), and schedules a reconnect.
 * On error: intentionally a no-op because the close event always follows.
 *
 * @throws Never — synchronous errors from the WebSocket constructor are caught
 *         and logged so they do not crash the application.
 */
function connect(): void {
  try {
    // Attempt to create a new WebSocket with the configured URL and API key header
    const ws = new WebSocket(CONFIG.wsUrl!, {
      headers: {
        "x-api-key": CONFIG.dbotxApiKey!,
      },
    });

    // ── Open handler ──────────────────────────────────────────────────────
    ws.addEventListener("open", () => {
      console.log("[DBotX] Connected");

      // Clear any pending reconnect timer since we are now connected
      reconnectTimer = null;
      // Push the new socket into the subject so streams pick it up
      wsSubject.next(ws);
    });

    // ── Close handler ─────────────────────────────────────────────────────
    ws.addEventListener("close", () => {
      // Notify subscribers that the socket is gone (for connected$, ws$)
      wsSubject.next(null);

      // Log the disconnection (throttled) and schedule an automatic retry
      logReconnect();
      scheduleReconnect();
    });

    // ── Error handler ─────────────────────────────────────────────────────
    ws.addEventListener("error", () => {
      // The browser / ws library fires "close" after "error", so reconnection
      // is handled entirely by the close listener. Nothing to do here.
    });
  } catch (error) {
    // Catch synchronous failures (e.g., invalid URL) so they don't crash
    // the process. Schedule a reconnect to retry.
    console.error("[DBotX] connect() failed:", error);
    scheduleReconnect();
  }
}

// Start immediately.
connect();

// -----------------------------------------------------------------------------
// Shared connection streams
// -----------------------------------------------------------------------------

/**
 * Stream of open WebSocket instances.
 *
 * Filters out null values (disconnected state) and replays the latest
 * WebSocket to late subscribers (bufferSize: 1, refCount: false keeps
 * the source alive even when there are zero subscribers).
 */
const ws$ = wsSubject.pipe(
  // Type-guard filter: strip null / disconnected values from the stream
  filter((ws): ws is WebSocket => ws !== null),
  // Cache the latest socket and replay it to every new subscriber;
  // refCount: false prevents teardown when subscribers drop to 0
  shareReplay({
    bufferSize: 1,
    refCount: false,
  }),
);

/**
 * Fires once every time the WebSocket (re-)connects.
 *
 * Maps the WebSocket instance to `undefined` so subscribers only
 * care about *when* a connection happens, not the socket reference.
 */
export const connected$ = ws$.pipe(
  // Drop the WebSocket reference — subscribers just need the signal
  map(() => undefined),
  // Ensure every subscriber gets the same multicast instance
  share(),
);

// -----------------------------------------------------------------------------
// Heartbeat
// -----------------------------------------------------------------------------

/**
 * Periodically send a WebSocket ping to keep the connection alive.
 *
 * When a connection event fires, `switchMap` tears down the previous
 * interval and starts a new one. This avoids stacking multiple pings.
 */
connected$
  .pipe(
    // On each connection: cancel the old heartbeat interval and start a new one
    switchMap(() => interval(CONFIG.wsHeartbeatIntervalMs)),
    // On each tick: send a ping frame if the socket is still open
    tap(() => {
      const ws = getSocket();

      // Guard: socket may have closed between the interval tick and now
      if (!ws) {
        return;
      }

      // Send the WebSocket ping frame
      ws.ping();
    }),
  )
  .subscribe();

// -----------------------------------------------------------------------------
// Restore subscriptions after reconnect
// -----------------------------------------------------------------------------

/**
 * On every WebSocket (re-)connection, re-subscribe to all currently active
 * signal pairs so we do not miss market data after a reconnect.
 */
connected$
  .pipe(
    // Side-effect: iterate over active signals and subscribe each pair
    tap(() => {
      let restored = 0;

      // Loop through all pairs that currently have active signals
      for (const pair of latestSignalState.activeSignals.keys()) {
        // Subscribe; increment counter only on success
        if (subscribePair(pair)) {
          restored++;
        }
      }

      // Log summary only if at least one subscription was re-issued
      if (restored > 0) {
        console.log(`[DBotX] Re-subscribed ${restored} active pair(s)`);
      }
    }),
  )
  .subscribe();

// -----------------------------------------------------------------------------
// Subscribe to newly accepted signals
// -----------------------------------------------------------------------------

/**
 * When a new signal is accepted, subscribe to its trading pair
 * so we receive real-time market data immediately.
 */
acceptedSignal$
  .pipe(
    // Side-effect: subscribe the pair of the newly accepted signal
    tap((signal) => {
      // Guard: skip if the send failed (e.g., socket not open)
      if (!subscribePair(signal.lpAddress, signal.contractAddress)) {
        return;
      }

      console.log(`[DBotX] Subscribe ${signal.tokenName}`);
    }),
  )
  .subscribe();

// -----------------------------------------------------------------------------
// Unsubscribe expired pairs
// -----------------------------------------------------------------------------

/**
 * When signals expire, unsubscribe their trading pairs to reduce
 * unnecessary data transfer.
 */
expiredPair$
  .pipe(
    // Side-effect: unsubscribe each expired pair
    tap((pairs) => {
      for (const pair of pairs) {
        // Guard: skip if the send failed (e.g., socket not open)
        if (!unsubscribePair(pair)) {
          continue;
        }

        console.log(`[DBotX] Unsubscribe ${pair}`);
      }
    }),
  )
  .subscribe();

// -----------------------------------------------------------------------------
// Raw message stream
// -----------------------------------------------------------------------------

/**
 * Stream of parsed JSON messages from the WebSocket.
 *
 * Uses `switchMap` so that when a new WebSocket replaces the old one
 * (after reconnect), the previous event listener is torn down and only
 * messages from the current socket are forwarded.
 */
const rawMessage$ = ws$.pipe(
  // switchMap: on each new WebSocket, unsubscribe from the old socket's
  // "message" events and subscribe to the new one
  switchMap((ws) => fromEvent<MessageEvent>(ws, "message")),

  // map: deserialise every MessageEvent's data from JSON string to object
  map((event) => {
    try {
      // Extract the payload — may already be a string or may need .toString()
      const raw =
        typeof event.data === "string" ? event.data : event.data.toString();

      // Attempt JSON parsing; typed as WsRawMessage at the call site
      return JSON.parse(raw) as WsRawMessage;
    } catch (error) {
      // If JSON parsing fails, log the error and the raw payload, then
      // return null so the downstream filter can drop this message
      console.error("[DBotX] Failed to parse message:", error, event.data);

      return null;
    }
  }),

  // filter (type guard): strip out the null values produced by parse failures
  filter((msg): msg is WsRawMessage => msg !== null),

  // share: make the stream hot so all subscribers receive the same messages
  share(),
);

// -----------------------------------------------------------------------------
// Ignore ACK packets and messages without pair information
// -----------------------------------------------------------------------------

/**
 * Stream of raw messages that contain meaningful market data.
 *
 * Filters out:
 * 1. Acknowledgment packets (status === "ack") which carry no market data.
 * 2. Messages that lack a pair identifier (cannot be correlated to a position).
 */
const dataMessage$ = rawMessage$.pipe(
  // Drop messages whose status is "ack" (server-side subscription confirmations)
  filter((msg) => msg.status !== "ack"),

  // Drop messages that have no pair identifier at the top level or in result
  filter((msg) => {
    return Boolean(msg.pair ?? msg.result?.pair);
  }),

  // Multicast so every derived stream shares the same filtered source
  share(),
);

// -----------------------------------------------------------------------------
// Convert raw DBotX payloads into strongly typed updates
// -----------------------------------------------------------------------------

/**
 * Stream of strongly-typed {@link PairUpdate} objects.
 *
 * Picks values from the top-level message fields first, falling back to
 * `msg.result.*` for messages that nest data in the result wrapper.
 */
export const pairUpdate$ = dataMessage$.pipe(
  // map: transform every raw message into a clean PairUpdate struct
  map((msg): PairUpdate => {
    // Pair identifier: prefer top-level, fall back to result wrapper, or empty
    const pair = msg.pair ?? msg.result?.pair ?? "";

    // Token address: prefer top-level, fall back to result wrapper
    const token = msg.token ?? msg.result?.token;

    // eslint-disable-next-line object-property-newline
    return {
      pair,
      token,

      // Safely coerce each numeric field; fall back to undefined if unavailable
      priceUsd: parseNumber(msg.priceUsd ?? msg.result?.priceUsd),
      marketCapUsd: parseNumber(msg.marketCapUsd ?? msg.result?.marketCapUsd),
      liquidityUsd: parseNumber(msg.liquidityUsd ?? msg.result?.liquidityUsd),
      holders: parseNumber(msg.holders ?? msg.result?.holders),

      // Use the server timestamp when available, otherwise fall back to now
      timestamp: msg.t ?? Date.now(),

      // Keep the raw message for debugging
      raw: msg,
    };
  }),

  // Multicast to all downstream convenience streams
  share(),
);

// -----------------------------------------------------------------------------
// Convenience streams
// -----------------------------------------------------------------------------

/**
 * Emits only when the update includes a priceUsd value.
 */
export const pairPrice$ = pairUpdate$.pipe(
  filter((update) => update.priceUsd !== undefined),
  share(),
);

/**
 * Emits only when the update includes a marketCapUsd value.
 */
export const marketCap$ = pairUpdate$.pipe(
  filter((update) => update.marketCapUsd !== undefined),
  share(),
);

/**
 * Emits only when the update includes a liquidityUsd value.
 */
export const liquidity$ = pairUpdate$.pipe(
  filter((update) => update.liquidityUsd !== undefined),
  share(),
);

/**
 * Emits only when the update includes a holders value.
 */
export const holders$ = pairUpdate$.pipe(
  filter((update) => update.holders !== undefined),
  share(),
);

// -----------------------------------------------------------------------------
// Connection state — exported helpers
// -----------------------------------------------------------------------------

/**
 * Check whether the WebSocket is currently connected and ready.
 *
 * @returns `true` if the socket exists and its readyState is OPEN.
 */
export function isConnected(): boolean {
  return getSocket() !== null;
}

/**
 * Return the current WebSocket handle (or null if not connected).
 *
 * @returns The open WebSocket, or null.
 */
export function currentSocket(): WebSocket | null {
  return getSocket();
}

// -----------------------------------------------------------------------------
// Manual subscription helpers — exported public API
// -----------------------------------------------------------------------------

/**
 * Subscribe to real-time market data for a trading pair.
 *
 * @param pair  - LP address / pair identifier.
 * @param token - Optional token contract address.
 * @returns `true` if the subscription request was sent successfully.
 */
export function subscribe(pair: string, token?: string): boolean {
  return subscribePair(pair, token);
}

/**
 * Unsubscribe from real-time market data for a trading pair.
 *
 * @param pair - LP address / pair identifier.
 * @returns `true` if the unsubscription request was sent successfully.
 */
export function unsubscribe(pair: string): boolean {
  return unsubscribePair(pair);
}

// -----------------------------------------------------------------------------
// Manual reconnect — exported public API
// -----------------------------------------------------------------------------

/**
 * Force a manual reconnect: close the current socket (if any) and open a new one.
 *
 * If no socket exists, it simply calls `connect()` directly.
 * Close errors are silently swallowed.
 */
export function reconnect(): void {
  // Read the current socket from the subject
  const ws = wsSubject.value;

  if (ws) {
    // Close the existing socket gracefully; errors (e.g., already closing) are
    // caught and ignored because the close event will trigger a reconnect anyway
    try {
      ws.close();
    } catch {
      // Ignore close errors (e.g., already closing state)
    }
  } else {
    // No socket exists — immediately attempt a fresh connection
    connect();
  }
}

// -----------------------------------------------------------------------------
// End of module
// -----------------------------------------------------------------------------
