import { Subject } from "rxjs";
import { CONFIG } from "../config";
import type { PriceInfo, PumpEvent, PriceUpdate } from "./types";
import { PriceSource } from "./types";
import { pumpEvent$ } from "./pumpapi_data_stream";
import { priceUpdate$, subscribePairs, unsubscribePair } from "./dbotx_data_stream";

const STALE_MS = 5_000;
const DEX_POLL_MS = 2_000;
const DEX_API = "https://api.dexscreener.com/tokens/v1/solana";

interface DexPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; symbol: string; name: string };
  quoteToken: { address: string; symbol: string };
  priceUsd: string;
  priceNative: string;
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
}

const priceCache = new Map<string, PriceInfo>();
let lastTimestamps = new Map<string, number>();
let dexTimer: ReturnType<typeof setInterval> | null = null;
let pumpSub: any = null;
let dbotxSub: any = null;

export const unifiedPriceUpdate$ = new Subject<PriceInfo>();

function isValidPrice(price: number): boolean {
  return Number.isFinite(price) && price > 0;
}

function emitPrice(token: string, pair: string | undefined, priceUsd: number, source: PriceSource, timestamp: number): void {
  if (!isValidPrice(priceUsd)) return;

  const lastTs = lastTimestamps.get(token) ?? 0;
  if (timestamp <= lastTs && source !== PriceSource.DEX) return;

  lastTimestamps.set(token, timestamp);

  const info: PriceInfo = { token, pair, priceUsd, source, timestamp };
  priceCache.set(token, info);
  unifiedPriceUpdate$.next(info);
}

function initPumpSub(): void {
  pumpSub = pumpEvent$.subscribe((event: PumpEvent) => {
    const price = parseFloat(event.price);
    if (!isValidPrice(price)) return;

    const timestamp = event.timestamp || Date.now();
    emitPrice(event.mint, undefined, price, PriceSource.PUMP, timestamp);
  });
}

function initDbotxSub(): void {
  dbotxSub = priceUpdate$.subscribe((update: PriceUpdate) => {
    const price = update.priceUsd;
    if (!isValidPrice(price)) return;

    emitPrice(update.token || update.pair, update.pair, price, PriceSource.DBOTX, update.timestamp);
  });
}

let trackedTokens = new Set<string>();
const tokenToPair = new Map<string, string>();

export function trackToken(token: string, pair?: string): void {
  trackedTokens.add(token);
  if (pair) {
    tokenToPair.set(token, pair);
    subscribePairs([pair]);
  }
}

export function untrackToken(token: string): void {
  trackedTokens.delete(token);
  priceCache.delete(token);
  lastTimestamps.delete(token);
  const pair = tokenToPair.get(token);
  if (pair) {
    unsubscribePair(pair);
    tokenToPair.delete(token);
  }
}

export function getLatestPrice(token: string): PriceInfo | null {
  return priceCache.get(token) ?? null;
}

function isStale(token: string): boolean {
  const info = priceCache.get(token);
  if (!info) return true;
  return Date.now() - info.timestamp > STALE_MS;
}

export function isPriceStale(token: string): boolean {
  return isStale(token);
}

async function pollDexScreener(): Promise<void> {
  if (trackedTokens.size === 0) return;

  const tokens = [...trackedTokens];
  const url = `${DEX_API}/${tokens.join(",")}`;

  try {
    const res = await fetch(url);
    if (!res.ok) return;

    const pairs = (await res.json()) as DexPair[];
    const bestPerToken = new Map<string, DexPair>();

    for (const pair of pairs) {
      const token = pair.baseToken.address;
      const current = bestPerToken.get(token);
      if (!current || (pair.liquidity?.usd ?? 0) > (current.liquidity?.usd ?? 0)) {
        bestPerToken.set(token, pair);
      }
    }

    const now = Date.now();
    for (const [token, pair] of bestPerToken) {
      const price = parseFloat(pair.priceUsd);
      if (!isValidPrice(price)) continue;

      const lastTs = lastTimestamps.get(token) ?? 0;
      if (now <= lastTs) continue;

      lastTimestamps.set(token, now);

      const info: PriceInfo = {
        token,
        pair: pair.pairAddress,
        priceUsd: price,
        source: PriceSource.DEX,
        timestamp: now,
      };
      priceCache.set(token, info);
      unifiedPriceUpdate$.next(info);
    }
  } catch {
    // ignore poll errors
  }
}

export function initPriceEngine(): void {
  if (pumpSub || dbotxSub) return;

  initPumpSub();
  initDbotxSub();

  dexTimer = setInterval(pollDexScreener, DEX_POLL_MS);

  console.log("[PriceEngine] Initialized (DBotX + PumpAPI + DexScreener)");
}

export function stopPriceEngine(): void {
  if (pumpSub) { pumpSub.unsubscribe(); pumpSub = null; }
  if (dbotxSub) { dbotxSub.unsubscribe(); dbotxSub = null; }
  if (dexTimer) { clearInterval(dexTimer); dexTimer = null; }
  priceCache.clear();
  lastTimestamps.clear();
  trackedTokens.clear();
  console.log("[PriceEngine] Stopped");
}
