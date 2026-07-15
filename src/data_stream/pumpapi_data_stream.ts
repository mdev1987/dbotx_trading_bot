import {
  BehaviorSubject,
  Subject,
  Subscription,
  fromEvent,
  interval,
} from "rxjs";
import { filter, map, share, takeUntil } from "rxjs/operators";

import { CONFIG } from "../config";
import { PriceSource, type PumpEvent, type PumpWsPacket } from "./types";

// ============================================================================
// Types
// ============================================================================

/**
 * Represents the current WebSocket connection state.
 */
export type ConnectionState = "disconnected" | "connecting" | "connected";

// ============================================================================
// Public Streams
// ============================================================================

/**
 * Emits a normalized trade event whenever PumpAPI publishes
 * a BUY or SELL transaction for a tracked token.
 */
export const pumpApiPriceUpdateEvent$ = new Subject<PumpEvent>();

/**
 * Emits connection state changes.
 *
 * Useful for:
 *  - Health monitoring
 *  - Terminal UI
 *  - Debugging
 *  - Automatic failover
 */
export const pumpConnectionState$ = new BehaviorSubject<ConnectionState>(
  "disconnected",
);

/**
 * Emits non-fatal errors encountered by this module.
 *
 * Parsing errors, socket errors, etc. are published here
 * instead of throwing and terminating the stream.
 */
export const pumpError$ = new Subject<unknown>();

// ============================================================================
// Internal State
// ============================================================================

/**
 * Active WebSocket connection.
 *
 * Only one connection should exist at any time.
 */
let socket: WebSocket | null = null;

/**
 * Reconnect timer.
 *
 * Prevents scheduling multiple reconnect attempts.
 */
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Owns every RxJS subscription created by this module.
 *
 * Calling unsubscribe() cleans up every active stream.
 */
let subscriptions = new Subscription();

/**
 * Emits once when the current connection is being destroyed.
 *
 * Long-running observables can use this with takeUntil()
 * for automatic cleanup.
 */
const destroy$ = new Subject<void>();

/**
 * Collection of token mints currently being monitored.
 *
 * When empty, all incoming trade events are accepted.
 */
const trackedMints = new Set<string>();

// ============================================================================
// Public API
// ============================================================================

/**
 * Starts tracking a token mint.
 *
 * Future events for this mint will be emitted through
 * pumpApiPriceUpdateEvent$.
 */
export function subscribeMint(mint: string): void {
  trackedMints.add(mint);
}

/**
 * Stops tracking a token mint.
 */
export function unsubscribeMint(mint: string): void {
  trackedMints.delete(mint);
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Disposes every active RxJS subscription.
 *
 * This prepares the module for creating a brand-new
 * WebSocket connection.
 */
function cleanup(): void {
  subscriptions.unsubscribe();
  subscriptions = new Subscription();

  destroy$.next();

  socket = null;
}

/**
 * Cancels any pending reconnect attempt.
 */
function clearReconnectTimer(): void {
  if (!reconnectTimer) {
    return;
  }

  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

/**
 * Schedules a reconnect after the configured delay.
 *
 * Multiple reconnect timers are never allowed.
 */
function scheduleReconnect(): void {
  if (reconnectTimer) {
    return;
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectPumpStream();
  }, CONFIG.wsReconnectDelayMs);
}

/**
 * Returns true if the incoming packet represents
 * a valid BUY or SELL trade.
 *
 * This function is also a TypeScript type guard.
 */
function isTradePacket(packet: PumpWsPacket): packet is PumpWsPacket & {
  mint: string;
  action: "buy" | "sell";
} {
  return (
    packet.type !== "pong" &&
    typeof packet.mint === "string" &&
    (packet.action === "buy" || packet.action === "sell")
  );
}

/**
 * Returns true when a mint should be processed.
 *
 * If no mints are subscribed, every trade is accepted.
 */
function isTrackedMint(mint: string): boolean {
  return trackedMints.size === 0 || trackedMints.has(mint);
}

/**
 * Converts a raw PumpAPI packet into the application's
 * normalized trade event.
 */
function toPumpEvent(
  packet: PumpWsPacket & {
    mint: string;
    action: "buy" | "sell";
  },
): PumpEvent {
  return {
    mint: packet.mint,
    action: packet.action,
    price: String(packet.price ?? ""),
    quoteMint: packet.quoteMint ?? "",
    source: PriceSource.PUMPAPI,
    timestamp: Date.now(),
  };
}

// ============================================================================
// Connection Management
// ============================================================================

/**
 * Creates a new WebSocket connection.
 *
 * The connection state is immediately updated to "connecting".
 * The caller is responsible for wiring the socket events.
 */
function connectSocket(): WebSocket {
  pumpConnectionState$.next("connecting");

  console.log("[PumpAPI] Connecting...");

  return new WebSocket(CONFIG.pumpapiWsUrl);
}

/**
 * Opens the PumpAPI WebSocket stream.
 *
 * If an active connection already exists, this function
 * safely returns without creating another connection.
 */
export function connectPumpStream(): void {
  // Prevent duplicate connections.
  if (
    socket?.readyState === WebSocket.OPEN ||
    socket?.readyState === WebSocket.CONNECTING
  ) {
    return;
  }

  cleanup();
  clearReconnectTimer();

  socket?.close();
  socket = connectSocket();

  // --------------------------------------------------------------------------
  // Native WebSocket events
  // --------------------------------------------------------------------------

  const open$ = fromEvent<Event>(socket, "open");

  const message$ = fromEvent<MessageEvent>(socket, "message").pipe(share());

  const error$ = fromEvent<Event>(socket, "error");

  const close$ = fromEvent<CloseEvent>(socket, "close");

  // --------------------------------------------------------------------------
  // Connection opened
  // --------------------------------------------------------------------------

  subscriptions.add(
    open$.subscribe(() => {
      console.log("[PumpAPI] Connected");

      pumpConnectionState$.next("connected");
    }),
  );

  // --------------------------------------------------------------------------
  // Socket errors
  // --------------------------------------------------------------------------

  subscriptions.add(
    error$.subscribe((error) => {
      console.error("[PumpAPI]", error);

      pumpError$.next(error);
    }),
  );

  // --------------------------------------------------------------------------
  // Parse incoming JSON packets.
  //
  // Invalid packets are ignored instead of terminating
  // the observable pipeline.
  // --------------------------------------------------------------------------

  const packet$ = message$.pipe(
    map(({ data }) => {
      if (typeof data !== "string") {
        return null;
      }

      try {
        return JSON.parse(data) as PumpWsPacket;
      } catch (error) {
        console.warn("[PumpAPI] Failed to parse packet:", error);

        pumpError$.next(error);

        return null;
      }
    }),

    filter((packet): packet is PumpWsPacket => packet !== null),

    // Multiple downstream streams share one parser.
    share(),
  );

  // --------------------------------------------------------------------------
  // Keep only BUY / SELL packets for tracked tokens.
  // --------------------------------------------------------------------------

  const tradePacket$ = packet$.pipe(
    filter(isTradePacket),

    filter((packet) => isTrackedMint(packet.mint)),

    share(),
  );

  // --------------------------------------------------------------------------
  // Convert PumpAPI packets into the application's
  // normalized trade model.
  // --------------------------------------------------------------------------

  const tradeEvent$ = tradePacket$.pipe(
    map(toPumpEvent),

    share(),
  );

  // --------------------------------------------------------------------------
  // Publish trade events.
  // --------------------------------------------------------------------------

  subscriptions.add(
    tradeEvent$.subscribe((event) => {
      pumpApiPriceUpdateEvent$.next(event);
    }),
  );

  // --------------------------------------------------------------------------
  // Heartbeat
  //
  // Periodically send a ping to keep the WebSocket connection alive.
  // The stream automatically stops when the socket is closed or the
  // service is disconnected.
  // --------------------------------------------------------------------------

  subscriptions.add(
    interval(CONFIG.wsHeartbeatIntervalMs)
      .pipe(takeUntil(close$), takeUntil(destroy$))
      .subscribe(() => {
        if (socket?.readyState !== WebSocket.OPEN) {
          return;
        }

        try {
          socket.send(JSON.stringify({ type: "ping" }));
        } catch (error) {
          console.warn("[PumpAPI] Failed to send heartbeat.", error);

          pumpError$.next(error);
        }
      }),
  );

  // --------------------------------------------------------------------------
  // Connection Closed
  //
  // Clean up the current connection and automatically reconnect after
  // a configurable delay.
  // --------------------------------------------------------------------------

  subscriptions.add(
    close$.subscribe((event) => {
      console.warn(
        `[PumpAPI] Disconnected (code=${event.code}, reason="${event.reason}")`,
      );

      pumpConnectionState$.next("disconnected");

      cleanup();

      scheduleReconnect();
    }),
  );
}

// ============================================================================
// Shutdown
// ============================================================================

/**
 * Gracefully disconnects the PumpAPI stream.
 *
 * This stops:
 *   - heartbeat
 *   - message processing
 *   - reconnection attempts
 *   - active subscriptions
 */
export function disconnectPumpStream(): void {
  clearReconnectTimer();

  pumpConnectionState$.next("disconnected");

  cleanup();

  if (socket && socket.readyState !== WebSocket.CLOSED) {
    socket.close();
  }

  socket = null;
}
