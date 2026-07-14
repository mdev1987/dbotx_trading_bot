import { Subject, Subscription, timer } from "rxjs";

import { CONFIG } from "../config";
import type {
  PriceInfo,
  DbotxEvent,
  TrackedToken,
} from "./types";
import { PriceSource } from "./types";
// import { pumpApiPriceUpdateEvent$ } from "./pumpapi_data_stream";
import {
  dbotxPriceUpdateEvent$,
  subscribePairs,
  unsubscribePair,
} from "./dbotx_data_stream";
// import { dexScreenerPriceUpdateEvent$, pollDexScreener } from "./dexscreener_polling";

function isValidPrice(price: number): boolean {
  return Number.isFinite(price) && price > 0;
}

const trackedTokens = new Map<string, TrackedToken>();
const pairToToken = new Map<string, string>();

export const unifiedPriceUpdate$ = new Subject<PriceInfo>();

// let pumpApiSub: Subscription | null = null;
let dbotxSub: Subscription | null = null;
// let dexScreenerSub: Subscription | null = null;
// let dexScreenerPollSub: Subscription | null = null;

/* -------------------------------------------------------------------------- */
/*                            SOL → USD rate                                  */
/* -------------------------------------------------------------------------- */

let solPriceUsd = 0;

/** Latest SOL/USD rate derived from DBotX trades. */
export function getSolPriceUsd(): number {
  return solPriceUsd;
}

function updateSolPriceFromEvent(priceUsd: number, priceSol: number): void {
  if (priceSol > 0 && priceUsd > 0) {
    solPriceUsd = priceUsd / priceSol;
  }
}

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

  // Ensure pair is always set — resolve from tracked token when omitted
  const resolvedPair = pair || tracked.pair;

  unifiedPriceUpdate$.next({
    token: resolvedToken,
    pair: resolvedPair,
    priceUsd,
    source,
    timestamp,
  });
}

// function initPumpSub(): void {
//   pumpApiSub = pumpApiPriceUpdateEvent$.subscribe((event: PumpEvent) => {
//     const price = parseFloat(event.price);
//     const timestamp = event.timestamp || Date.now();
//     if (!isValidPrice(price)) return;
// 
//     let priceUsd: number;
// 
//     if (event.quoteMint === "So11111111111111111111111111111111111111112") {
//       if (solPriceUsd <= 0) return;
//       priceUsd = price * solPriceUsd;
//     } else {
//       priceUsd = price;
//     }
// 
//     emitPrice(event.mint, undefined, priceUsd, PriceSource.PUMPAPI, timestamp);
//   });
// }

function initDbotxSub(): void {
  dbotxSub = dbotxPriceUpdateEvent$.subscribe((update: DbotxEvent) => {
    const price = update.priceUsd;
    if (!isValidPrice(price)) return;
    updateSolPriceFromEvent(update.priceUsd, update.priceSol);
    emitPrice(
      update.token,
      update.pair,
      price,
      update.source,
      update.timestamp,
    );
  });
}

// function initDexScreenerSub(): void {
//   dexScreenerSub = dexScreenerPriceUpdateEvent$.subscribe(
//     (update: DexScreenerEvent) => {
//       const price = update.priceUsd;
//       if (!isValidPrice(price)) return;
//       emitPrice(
//         update.token,
//         update.pair,
//         price,
//         update.source,
//         update.timestamp,
//       );
//     },
//   );
// }

// function initDexScreenerPolling(): void {
//   dexScreenerPollSub = timer(
//     CONFIG.dexscreenerPollIntervalMs,
//     CONFIG.dexscreenerPollIntervalMs,
//   ).subscribe(() => {
//     const tokens = [...trackedTokens.keys()];
//     if (tokens.length > 0) {
//       pollDexScreener(tokens);
//     }
//   });
// }

export function initPriceEngine(): void {
  if (dbotxSub) {
    return;
  }
  initDbotxSub();
  // initPumpSub();
  // initDexScreenerSub();
  // initDexScreenerPolling();
  console.log("[PriceEngine] Initialized");
}

export function stopPriceEngine(): void {
  // pumpApiSub?.unsubscribe();
  dbotxSub?.unsubscribe();
  // dexScreenerSub?.unsubscribe();
  // dexScreenerPollSub?.unsubscribe();

  // pumpApiSub = null;
  dbotxSub = null;
  // dexScreenerSub = null;
  // dexScreenerPollSub = null;

  for (const tracked of trackedTokens.values()) {
    unsubscribePair(tracked.pair);
  }
  trackedTokens.clear();
  pairToToken.clear();

  console.log("[PriceEngine] Stopped");
}
