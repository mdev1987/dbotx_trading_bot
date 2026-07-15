import { Subject, Subscription } from "rxjs";

import type {
  PriceInfo,
  DbotxEvent,
  PumpEvent,
  TrackedToken,
} from "./types";
import { PriceSource } from "./types";
import {
  dbotxPriceUpdateEvent$,
  subscribePairs,
  unsubscribePair,
} from "./dbotx_data_stream";
import { pumpApiPriceUpdateEvent$ } from "./pumpapi_data_stream";

function isValidPrice(price: number): boolean {
  return Number.isFinite(price) && price > 0;
}

const trackedTokens = new Map<string, TrackedToken>();
const pairToToken = new Map<string, string>();

export const unifiedPriceUpdate$ = new Subject<PriceInfo>();

let pumpApiSub: Subscription | null = null;
let dbotxSub: Subscription | null = null;

/* -------------------------------------------------------------------------- */
/*                        Token tracking                                      */
/* -------------------------------------------------------------------------- */

export function trackToken(token: string, pair: string): void {
  const tracked = trackedTokens.get(token);

  if (tracked) {
    if (tracked.pair !== pair) {
      pairToToken.delete(tracked.pair);
      unsubscribePair(tracked.pair);
      subscribePairs([pair]);
      pairToToken.set(pair, token);
      tracked.pair = pair;
    }

    tracked.timestamp = Date.now();
    return;
  }

  pairToToken.set(pair, token);
  trackedTokens.set(token, { pair, timestamp: Date.now() });
  subscribePairs([pair]);
}

export function untrackToken(token: string): void {
  const tracked = trackedTokens.get(token);
  if (!tracked) {
    return;
  }

  pairToToken.delete(tracked.pair);
  unsubscribePair(tracked.pair);
  trackedTokens.delete(token);
}

/* -------------------------------------------------------------------------- */
/*                          Emit price                                        */
/* -------------------------------------------------------------------------- */

function emitPrice(
  token: string,
  pair: string | undefined,
  priceUsd: number,
  source: PriceSource,
  timestamp: number,
): void {
  const resolvedToken = token || (pair ? pairToToken.get(pair) : undefined);

  if (!resolvedToken) {
    return;
  }

  const tracked = trackedTokens.get(resolvedToken);

  if (!tracked) {
    return;
  }

  if (pair && tracked.pair !== pair) {
    return;
  }

  tracked.timestamp = timestamp;

  const resolvedPair = pair || tracked.pair;

  unifiedPriceUpdate$.next({
    token: resolvedToken,
    pair: resolvedPair,
    priceUsd,
    source,
    timestamp,
    currency: source === PriceSource.PUMPAPI ? "SOL" : "USD",
  });
}

function initDbotxSub(): void {
  dbotxSub = dbotxPriceUpdateEvent$.subscribe((update: DbotxEvent) => {
    const price = update.priceUsd;
    if (!isValidPrice(price)) return;
    emitPrice(
      update.token,
      update.pair,
      price,
      update.source,
      update.timestamp,
    );
  });
}

function initPumpSub(): void {
  pumpApiSub = pumpApiPriceUpdateEvent$.subscribe((event: PumpEvent) => {
    const rawPrice = Number(event.price);
    if (!isValidPrice(rawPrice)) return;

    emitPrice(event.mint, undefined, rawPrice, PriceSource.PUMPAPI, event.timestamp ?? Date.now());
  });
}

export function initPriceEngine(usePumpApi?: boolean): void {
  if (usePumpApi) {
    if (pumpApiSub) return;
    initPumpSub();
  } else {
    if (dbotxSub) return;
    initDbotxSub();
  }
  console.log(`[PriceEngine] Initialized (source: ${usePumpApi ? "PumpAPI" : "DBotX"})`);
}

export function stopPriceEngine(): void {
  pumpApiSub?.unsubscribe();
  dbotxSub?.unsubscribe();

  pumpApiSub = null;
  dbotxSub = null;

  for (const tracked of trackedTokens.values()) {
    unsubscribePair(tracked.pair);
  }
  trackedTokens.clear();
  pairToToken.clear();

  console.log("[PriceEngine] Stopped");
}
