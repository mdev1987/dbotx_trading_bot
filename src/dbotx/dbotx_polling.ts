/**
 * DBotX Polling Services
 *
 * Responsibilities:
 * -----------------
 * - REST fallback price polling
 * - Simulator account refresh
 * - Simulator trade pair polling
 * - Simulator PnL task polling
 *
 * This module does NOT:
 * - Execute trades
 * - Manage positions
 * - Send Telegram messages
 * - Handle WebSockets
 */

import { Observable, Subject, timer } from "rxjs";
import {
  filter,
  withLatestFrom,
  concatMap,
  switchMap,
  catchError,
} from "rxjs/operators";

import { CONFIG } from "../config";

import {
  fetchSimAccount,
  fetchTradePairs,
  fetchPnLTasks,
} from "./dbotx_simulator_api";

import { getPairPrice } from "./dbotx_http";

import type {
  SimulatorAccount,
  TradePair,
  PnLTask,
} from "./dbotx_simulator_api";

import type { PriceUpdate } from "./types";

import { pushPriceUpdate } from "./dbotx_data_ws";

/* -------------------------------------------------------------------------- */
/*                              Types                                         */
/* -------------------------------------------------------------------------- */

export interface PollingPosition {
  pair: string;
  token: string;
  status: "open" | "closed";
  tokenName?: string;
}

export interface PollingEvents {
  /**
   * Emits updated simulator account.
   */
  account$: Observable<SimulatorAccount>;

  /**
   * Emits simulator trade pair updates.
   */
  tradePairs$: Observable<TradePair>;

  /**
   * Emits PnL order updates.
   */
  pnlTasks$: Observable<{
    orderId: string;
    tasks: PnLTask[];
  }>;
}

/* -------------------------------------------------------------------------- */
/*                         Internal Subjects                                  */
/* -------------------------------------------------------------------------- */

const accountSubject = new Subject<SimulatorAccount>();

const tradePairSubject = new Subject<TradePair>();

const pnlTaskSubject = new Subject<{
  orderId: string;
  tasks: PnLTask[];
}>();

export const pollingEvents: PollingEvents = {
  account$: accountSubject.asObservable(),

  tradePairs$: tradePairSubject.asObservable(),

  pnlTasks$: pnlTaskSubject.asObservable(),
};

/* -------------------------------------------------------------------------- */
/*                         Price Polling                                      */
/* -------------------------------------------------------------------------- */

/**
 * REST price fallback.
 *
 * Used when:
 *
 * - DBotX websocket disconnects
 * - Testing
 * - Simulator mode
 *
 */
export function startPricePolling(
  openPositions$: Observable<PollingPosition[]>,
): void {
  timer(0, CONFIG.pricePollingIntervalMs)
    .pipe(
      withLatestFrom(openPositions$),

      concatMap(async ([, positions]) => {
        const active = positions.filter((p) => p.status === "open");

        if (active.length === 0) return;

        for (const position of active) {
          try {
            const price = await getPairPrice(position.pair);

            if (!price || price <= 0) continue;

            const update: PriceUpdate = {
              pair: position.pair,

              token: position.token,

              priceUsd: price,

              timestamp: Date.now(),
            };

            pushPriceUpdate(update);
          } catch (error) {
            console.warn("[DBotX] Price polling failed", error);
          }
        }
      }),
    )
    .subscribe();
}

/* -------------------------------------------------------------------------- */
/*                         Simulator Account                                  */
/* -------------------------------------------------------------------------- */

/**
 * Periodically refresh simulator wallet.
 */
export function startSimulatorAccountPolling(): void {
  if (CONFIG.liveMode) return;

  timer(0, CONFIG.accountPollingIntervalMs)
    .pipe(
      switchMap(() => fetchSimAccount().catch(() => null)),

      filter((account): account is SimulatorAccount => account !== null),
    )
    .subscribe((account) => {
      accountSubject.next(account);
    });
}

/* -------------------------------------------------------------------------- */
/*                      Simulator Trade Pair Polling                           */
/* -------------------------------------------------------------------------- */

/**
 * Polls DBotX simulator positions.
 *
 * Detects:
 *
 * - simulated buy execution
 * - simulated sell execution
 *
 */
export function startSimulatorTradePolling(
  openPositions$: Observable<PollingPosition[]>,
): void {
  if (CONFIG.liveMode) return;

  timer(0, CONFIG.tradePollingIntervalMs)
    .pipe(
      withLatestFrom(openPositions$),

      filter(([, positions]) => positions.some((p) => p.status === "open")),

      concatMap(async () => {
        try {
          return await fetchTradePairs(true);
        } catch {
          return [];
        }
      }),
    )
    .subscribe((pairs) => {
      for (const pair of pairs) {
        tradePairSubject.next(pair);
      }
    });
}

/* -------------------------------------------------------------------------- */
/*                      Simulator PnL Polling                                  */
/* -------------------------------------------------------------------------- */

/**
 * Polls DBotX take profit /
 * stop loss tasks.
 */
export function startPnLPolling(orderIds$: Observable<string[]>): void {
  if (CONFIG.liveMode) return;

  timer(0, CONFIG.pnlPollingIntervalMs)
    .pipe(
      withLatestFrom(orderIds$),

      filter(([, ids]) => ids.length > 0),

      concatMap(async ([, ids]) => {
        for (const id of ids) {
          try {
            const tasks = await fetchPnLTasks(id);

            pnlTaskSubject.next({
              orderId: id,

              tasks,
            });
          } catch (error) {
            console.warn("[DBotX] PNL polling failed", id);
          }
        }
      }),
    )
    .subscribe();
}

/* -------------------------------------------------------------------------- */
/*                              Shutdown                                      */
/* -------------------------------------------------------------------------- */

export function shutdownPolling(): void {
  console.log("[DBotX] Polling shutdown");
}
