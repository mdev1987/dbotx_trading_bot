/* ============================================================
 * dbotx_ws.ts
 *
 * Reactive DBotX websocket client.
 *
 * Responsibilities:
 *
 * - Open websocket connection
 * - Keep heartbeat alive
 * - Subscribe accepted signals
 * - Unsubscribe expired signals
 * - Emit pair updates
 *
 * No classes.
 * No mutable singleton state.
 * No EventEmitter.
 *
 * ============================================================
 */

import { fromEvent, interval, merge } from "rxjs";

import { filter, map, share, switchMap, tap } from "rxjs/operators";

import { CONFIG } from "../config";

import { acceptedSignal$, expiredPair$ } from "../telegram/signals_stream";

/* ============================================================
 * Types
 * ============================================================
 */

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

/* ============================================================
 * Websocket
 * ============================================================
 */

export const ws = new WebSocket(CONFIG.wsUrl!, {
  headers: {
    "x-api-key": CONFIG.dbotxApiKey!,
  },
});

/* ============================================================
 * Connection streams
 * ============================================================
 */

export const connected$ = fromEvent(ws, "open").pipe(
  tap(() => {
    console.log("[DBotX] Connected");
  }),
  share(),
);

export const disconnected$ = fromEvent(ws, "close").pipe(
  tap(() => {
    console.log("[DBotX] Disconnected");
  }),
  share(),
);

export const error$ = fromEvent(ws, "error").pipe(
  tap((error) => {
    console.error("[DBotX] Error", error);
  }),
  share(),
);

/* ============================================================
 * Heartbeat
 *
 * DBotX requires heartbeat every 30-55 seconds.
 * ============================================================
 */

connected$
  .pipe(
    switchMap(() => interval(30_000)),

    tap(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }),
  )
  .subscribe();

/* ============================================================
 * Subscribe new accepted pairs
 * ============================================================
 */

connected$
  .pipe(
    switchMap(() => acceptedSignal$),

    tap((signal) => {
      ws.send(
        JSON.stringify({
          method: "subscribe",
          type: "pairInfo",
          args: {
            pair: signal.lpAddress,
            token: signal.contractAddress,
          },
        }),
      );

      console.log(`[DBotX] Subscribe ${signal.tokenName}`);
    }),
  )
  .subscribe();

/* ============================================================
 * Unsubscribe expired pairs
 * ============================================================
 */

connected$
  .pipe(
    switchMap(() => expiredPair$),

    tap((pairs) => {
      for (const pair of pairs) {
        ws.send(
          JSON.stringify({
            method: "unsubscribe",
            type: "pairInfo",
            args: {
              pair,
            },
          }),
        );

        console.log(`[DBotX] Unsubscribe ${pair}`);
      }
    }),
  )
  .subscribe();

/* ============================================================
 * Raw websocket messages
 * ============================================================
 */

const rawMessage$ = fromEvent<MessageEvent>(ws, "message").pipe(
  map((event) => JSON.parse(event.data.toString())),

  share(),
);

/* ============================================================
 * Ignore ACK packets
 * ============================================================
 */

const dataMessage$ = rawMessage$.pipe(
  filter((msg) => msg.status !== "ack"),

  filter((msg) => msg.pair || msg.result?.pair),

  share(),
);

/* ============================================================
 * Pair updates
 * ============================================================
 */

export const pairUpdate$ = dataMessage$.pipe(
  map(
    (msg): PairUpdate => ({
      pair: msg.pair ?? msg.result?.pair,

      token: msg.token ?? msg.result?.token,

      priceUsd: msg.priceUsd ?? msg.result?.priceUsd,

      marketCapUsd: msg.marketCapUsd ?? msg.result?.marketCapUsd,

      liquidityUsd: msg.liquidityUsd ?? msg.result?.liquidityUsd,

      holders: msg.holders ?? msg.result?.holders,

      timestamp: msg.t ?? Date.now(),

      raw: msg,
    }),
  ),

  share(),
);
