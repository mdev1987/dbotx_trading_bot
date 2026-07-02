/**
 * market/dbotx_data_ws.ts
 *
 * Reactive DBotX WebSocket client with auto-reconnect.
 *
 * Responsibilities:
 *  - Open WebSocket connection
 *  - Auto-reconnect on close / error (with debounce to prevent races)
 *  - Keep heartbeat alive via ping frames
 *  - Subscribe newly accepted pairs
 *  - Unsubscribe expired pairs
 *  - Re-subscribe all active pairs on reconnect (reads latestSignalState
 *    synchronously so no fresh subscription to the scan is needed)
 *  - Emit pairUpdate$ stream for the rest of the system
 *
 * No classes.  No EventEmitter.  WebSocket lifecycle is managed via
 * a BehaviorSubject<WebSocket | null>.
 */

import { BehaviorSubject, fromEvent, interval } from "rxjs";
import { filter, map, share, shareReplay, switchMap, tap } from "rxjs/operators";
import { CONFIG } from "../config";
import { acceptedSignal$, expiredPair$, latestSignalState } from "../telegram/signals_stream";

/* ---------------------------------------------------------------
 * Types
 * ------------------------------------------------------------ */

export interface PairUpdate {
  pair: string;
  token?: string;
  priceUsd?: number;
  marketCapUsd?: number;
  liquidityUsd?: number;
  holders?: number;
  timestamp: number;
  raw: unknown;
}

/* ---------------------------------------------------------------
 * Reactive WebSocket lifecycle
 * ------------------------------------------------------------ */

const RECONNECT_DELAY_MS = 5_000;
const wsSubject = new BehaviorSubject<WebSocket | null>(null);
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let _lastDisconnectLog = 0;

function connect(): void {
  const ws = new WebSocket(CONFIG.wsUrl!, {
    headers: { "x-api-key": CONFIG.dbotxApiKey! },
  });

  ws.addEventListener("open", () => {
    console.log("[DBotX] Connected");
    wsSubject.next(ws);
  });

  ws.addEventListener("close", () => {
    const now = Date.now();
    if (now - _lastDisconnectLog > 30_000) {
      console.log(
        `[DBotX] Disconnected — reconnecting in ${RECONNECT_DELAY_MS}ms`,
      );
      _lastDisconnectLog = now;
    }

    if (_reconnectTimer !== null) clearTimeout(_reconnectTimer);
    _reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
  });

  ws.addEventListener("error", () => {
    /* close always fires after error — reconnect handled there */
  });
}

connect();

/** Observable that emits the current WebSocket once connected. */
const ws$ = wsSubject.pipe(
  filter((ws): ws is WebSocket => ws !== null),
  shareReplay({ bufferSize: 1, refCount: false }),
);

/* ---------------------------------------------------------------
 * Connection streams
 * ------------------------------------------------------------ */

export const connected$ = ws$.pipe(
  switchMap((ws) => fromEvent(ws, "open")),
  share(),
);

export const disconnected$ = ws$.pipe(
  switchMap((ws) => fromEvent(ws, "close")),
  tap(() => console.log("[DBotX] Disconnected")),
  share(),
);

/* ---------------------------------------------------------------
 * Heartbeat — ping every 30s
 * ------------------------------------------------------------ */

connected$
  .pipe(
    switchMap(() => interval(30_000)),
    tap(() => {
      const ws = wsSubject.value;
      if (ws && ws.readyState === WebSocket.OPEN) ws.ping();
    }),
  )
  .subscribe();

/* ---------------------------------------------------------------
 * Re-subscribe all active pairs on (re)connect
 *
 * Reads latestSignalState synchronously — no new scan subscription,
 * so it always sees the current active pairs regardless of how many
 * times we reconnect.
 * ------------------------------------------------------------ */

connected$
  .pipe(
    tap(() => {
      const ws = wsSubject.value;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      const active = latestSignalState.active;
      let count = 0;

      for (const pair of active.keys()) {
        ws.send(JSON.stringify({ method: "subscribe", type: "pairInfo", args: { pair } }));
        count++;
      }

      if (count > 0) console.log(`[DBotX] Re-subscribed ${count} active pair(s)`);
    }),
  )
  .subscribe();

/* ---------------------------------------------------------------
 * Subscribe newly accepted pairs
 *
 * Not gated by connected$ — if the WS is not open the message is
 * silently dropped.  The re-subscribe-on-reconnect handler above
 * will catch up once the connection is restored.
 * ------------------------------------------------------------ */

acceptedSignal$
  .pipe(
    tap((signal) => {
      const ws = wsSubject.value;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      ws.send(
        JSON.stringify({
          method: "subscribe",
          type: "pairInfo",
          args: { pair: signal.lpAddress, token: signal.contractAddress },
        }),
      );

      console.log(`[DBotX] Subscribe ${signal.tokenName}`);
    }),
  )
  .subscribe();

/* ---------------------------------------------------------------
 * Unsubscribe expired pairs
 * ------------------------------------------------------------ */

expiredPair$
  .pipe(
    tap((pairs) => {
      const ws = wsSubject.value;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      for (const pair of pairs) {
        ws.send(
          JSON.stringify({ method: "unsubscribe", type: "pairInfo", args: { pair } }),
        );
        console.log(`[DBotX] Unsubscribe ${pair}`);
      }
    }),
  )
  .subscribe();

/* ---------------------------------------------------------------
 * Raw WebSocket messages
 * ------------------------------------------------------------ */

const rawMessage$ = ws$.pipe(
  switchMap((ws) => fromEvent<MessageEvent>(ws, "message")),
  map((event) => {
    try {
      const raw = typeof event.data === "string" ? event.data : event.data.toString();
      return JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      console.error("[DBotX] Failed to parse message:", err, event.data);
      return null;
    }
  }),
  filter((msg): msg is Record<string, unknown> => msg !== null),
  share(),
);

/* ---------------------------------------------------------------
 * Data messages (ignore ACKs)
 * ------------------------------------------------------------ */

const dataMessage$ = rawMessage$.pipe(
  filter((msg) => msg.status !== "ack"),
  filter((msg) => {
    const result = msg.result as Record<string, unknown> | undefined;
    return !!(msg.pair as string | undefined) || !!(result?.pair as string | undefined);
  }),
  share(),
);

/* ---------------------------------------------------------------
 * Pair updates
 *
 * Numeric fields are parsed through Number() so that a string like
 * "0.000123" from the server is correctly converted to a number
 * instead of silently flowing through as a string.
 * ------------------------------------------------------------ */

function num(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export const pairUpdate$ = dataMessage$.pipe(
  map((msg): PairUpdate => {
    const result = msg.result as Record<string, unknown> | undefined;

    return {
      pair: ((msg.pair as string | undefined) ?? (result?.pair as string | undefined) ?? ""),
      token: ((msg.token as string | undefined) ?? (result?.token as string | undefined)),
      priceUsd: num(msg.priceUsd ?? result?.priceUsd),
      marketCapUsd: num(msg.marketCapUsd ?? result?.marketCapUsd),
      liquidityUsd: num(msg.liquidityUsd ?? result?.liquidityUsd),
      holders: num(msg.holders ?? result?.holders),
      timestamp: (msg.t as number | undefined ?? Date.now()),
      raw: msg,
    };
  }),
  share(),
);
