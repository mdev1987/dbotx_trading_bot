import { Subject, Subscription } from "rxjs";

import type { PriceInfo, DexScreenerEvent, TrackedToken } from "./types";
import { PriceSource } from "./types";
import {
  dexScreenerPriceUpdateEvent$,
  subscribeToken as dexSubscribeToken,
  unsubscribeToken as dexUnsubscribeToken,
  disconnectDexScreener,
} from "./dexscreener_data_stream";
import { CONFIG } from "../config";

function isValidPrice(price: number): boolean {
  return Number.isFinite(price) && price > 0;
}

const trackedTokens = new Map<string, TrackedToken>();
const pairToToken = new Map<string, string>();

const DEBUG = CONFIG.logLevel === "debug";

export const unifiedPriceUpdate$ = new Subject<PriceInfo>();

let dexSub: Subscription | null = null;

/* -------------------------------------------------------------------------- */
/*                        Token tracking                                      */
/* -------------------------------------------------------------------------- */

export function trackToken(token: string, pair: string): void {
  const tracked = trackedTokens.get(token);

  if (tracked) {
    if (tracked.pair !== pair) {
      if (DEBUG) console.log(`[PriceEngine] Re-track ${token.slice(0, 8)}: ${tracked.pair.slice(0, 8)} → ${pair.slice(0, 8)}`);
      pairToToken.delete(tracked.pair);
      pairToToken.set(pair, token);
      tracked.pair = pair;
    }

    tracked.timestamp = Date.now();
    return;
  }

  if (DEBUG) console.log(`[PriceEngine] Track ${token.slice(0, 8)} pair=${pair.slice(0, 8)}`);
  pairToToken.set(pair, token);
  trackedTokens.set(token, { pair, timestamp: Date.now() });
  dexSubscribeToken(token, "solana", pair);
}

export function untrackToken(token: string): void {
  const tracked = trackedTokens.get(token);
  if (!tracked) return;

  if (DEBUG) console.log(`[PriceEngine] Untrack ${token.slice(0, 8)}`);
  pairToToken.delete(tracked.pair);
  dexUnsubscribeToken(token);
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
  if (!resolvedToken) return;

  const tracked = trackedTokens.get(resolvedToken);
  if (!tracked) return;

  if (pair && tracked.pair !== pair) return;

  tracked.timestamp = timestamp;
  const resolvedPair = pair || tracked.pair;

  if (DEBUG) console.log(`[PriceEngine] Price ${resolvedToken.slice(0, 8)}: \$${priceUsd.toExponential(4)} (${source})`);

  unifiedPriceUpdate$.next({
    token: resolvedToken,
    pair: resolvedPair,
    priceUsd,
    source,
    timestamp,
    currency: "USD",
  });
}

function initDexSub(): void {
  dexSub = dexScreenerPriceUpdateEvent$.subscribe((event: DexScreenerEvent) => {
    if (!isValidPrice(event.priceUsd)) return;
    emitPrice(event.token, event.pair, event.priceUsd, PriceSource.DEXSCREENER, event.timestamp);
  });
}

export function initPriceEngine(): void {
  if (dexSub) return;
  initDexSub();
  console.log("[PriceEngine] Initialized (DexScreener)");
}

export function stopPriceEngine(): void {
  dexSub?.unsubscribe();
  dexSub = null;

  for (const [token] of trackedTokens) {
    dexUnsubscribeToken(token);
  }
  trackedTokens.clear();
  pairToToken.clear();

  disconnectDexScreener();
  console.log("[PriceEngine] Stopped");
}
