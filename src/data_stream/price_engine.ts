import { Subject } from "rxjs";
import { CONFIG } from "../config";
import type {
  PriceInfo,
  PumpEvent,
  DbotxEvent,
  TrackedToken,
  DexScreenerEvent,
} from "./types";
import { PriceSource } from "./types";
import { pumpApiPriceUpdateEvent$ } from "./pumpapi_data_stream";
import {
  dbotxPriceUpdateEvent$,
  subscribePairs,
  unsubscribePair,
} from "./dbotx_data_stream";
import { dexScreenerPriceUpdateEvent$ } from "./dexscreener_polling";
import { Subscription } from "rxjs";

function isValidPrice(price: number): boolean {
  return Number.isFinite(price) && price > 0;
}

const trackedTokens = new Map<string, TrackedToken>();

export const unifiedPriceUpdate$ = new Subject<PriceInfo>();

let pumpApiSub: Subscription | null = null;
let dbotxSub: Subscription | null = null;
let dexScreenerSub: Subscription | null = null;

export function trackToken(token: string, pair: string): void {
  const tracked = trackedTokens.get(token);

  if (tracked) {
    if (tracked.pair !== pair) {
      unsubscribePair(tracked.pair);
      subscribePairs([pair]);
      tracked.pair = pair;
    }

    tracked.timestamp = Date.now();
    return;
  }
}

export function untrackToken(token: string): void {
  const tracked = trackedTokens.get(token);
  if (!tracked) {
    return;
  }

  unsubscribePair(tracked.pair);
  trackedTokens.delete(token);
}

function emitPrice(
  token: string,
  pair: string | undefined,
  priceUsd: number,
  source: PriceSource,
  timestamp: number,
): void {
  const tracked = trackedTokens.get(token);

  if (!tracked) {
    return;
  }

  // Ignore prices from a different LP.
  if (pair && tracked.pair !== pair) {
    return;
  }

  tracked.timestamp = timestamp;

  unifiedPriceUpdate$.next({
    token,
    pair,
    priceUsd,
    source,
    timestamp,
  });
}

function initPumpSub(): void {
  pumpApiSub = pumpApiPriceUpdateEvent$.subscribe((event: PumpEvent) => {
    const price = parseFloat(event.price);
    const timestamp = event.timestamp || Date.now();
    if (!isValidPrice(price)) return;
    emitPrice(event.mint, undefined, price, PriceSource.PUMPAPI, timestamp);
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

function initDexScreenerSub(): void {
  dexScreenerSub = dexScreenerPriceUpdateEvent$.subscribe(
    (update: DexScreenerEvent) => {
      const price = update.priceUsd;
      if (!isValidPrice(price)) return;
      emitPrice(
        update.token,
        update.pair,
        price,
        update.source,
        update.timestamp,
      );
    },
  );
}

export function initPriceEngine(): void {
  if (pumpApiSub || dbotxSub || dexScreenerSub) {
    return;
  }
  initPumpSub();
  initDbotxSub();
  initDexScreenerSub();
  console.log("[PriceEngine] Initialized");
}

export function stopPriceEngine(): void {
  pumpApiSub?.unsubscribe();
  dbotxSub?.unsubscribe();
  dexScreenerSub?.unsubscribe();

  pumpApiSub = null;
  dbotxSub = null;
  dexScreenerSub = null;
  for (const tracked of trackedTokens.values()) {
    unsubscribePair(tracked.pair);
  }
  trackedTokens.clear();

  console.log("[PriceEngine] Stopped");
}
