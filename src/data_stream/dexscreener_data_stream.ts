import { Subject } from "rxjs";

import { PriceSource, type DexPair, type DexScreenerEvent } from "./types";
import { CONFIG } from "../config";

// ============================================================================
// Public Streams
// ============================================================================

export const dexScreenerPriceUpdateEvent$ = new Subject<DexScreenerEvent>();

export type DexConnectionState = "idle" | "polling" | "error";
export const dexScreenerState$ = new Subject<DexConnectionState>();

// ============================================================================
// Interfaces for one-shot batch queries
// ============================================================================

export interface Token {
  CA: string;
  LP: string;
}

export interface TokenPrice {
  CA: string;
  LP: string;
  pair?: DexPair;
}

// ============================================================================
// Internal State
// ============================================================================

const dexAPIBaseURL = CONFIG.dexscreenerApiUrl;

const pollIntervalMS = CONFIG.dexscreenerPollIntervalMs;

interface TrackEntry {
  chainId: string;
  token: string;
  pairAddress?: string;
}

const tracked = new Map<string, TrackEntry>();

let timer: ReturnType<typeof setTimeout> | null = null;

let chunks: string[][] = [];
let chunkIndex = 0;

// ============================================================================
// Public API — one-shot batch query
// ============================================================================

export async function getTokenPrices(
  tokens: Token[],
  chainId = "solana",
): Promise<TokenPrice[]> {
  if (tokens.length === 0) return [];

  if (tokens.length > 30) {
    throw new Error("DexScreener supports a maximum of 30 tokens per request.");
  }

  const url = `${dexAPIBaseURL}/${chainId}/${tokens.map((t) => t.CA).join(",")}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`DexScreener HTTP ${response.status}`);
  }

  const pairs = (await response.json()) as DexPair[];

  return tokens.map((token) => ({
    CA: token.CA,
    LP: token.LP,
    pair: pairs.find(
      (pair) =>
        pair.baseToken.address === token.CA &&
        pair.pairAddress === token.LP,
    ),
  }));
}

// ============================================================================
// Public API — streaming
// ============================================================================

export function subscribeToken(
  token: string,
  chainId = "solana",
  pairAddress?: string,
): void {
  if (tracked.has(token)) return;
  tracked.set(token, { chainId, token, pairAddress });
  rebuildChunks();
  if (tracked.size === 1) startPolling();
}

export function unsubscribeToken(token: string): void {
  if (!tracked.has(token)) return;
  tracked.delete(token);
  rebuildChunks();
  if (tracked.size === 0) stopPolling();
}

// ============================================================================
// Chunk management
// ============================================================================

function rebuildChunks(): void {
  const addresses = Array.from(tracked.values()).map((e) => e.token);
  chunks = [];
  for (let i = 0; i < addresses.length; i += 30) {
    chunks.push(addresses.slice(i, i + 30));
  }
  chunkIndex = 0;
}

// ============================================================================
// Polling — batch, 1 chunk per interval tick
// ============================================================================

function startPolling(): void {
  if (timer) return;
  dexScreenerState$.next("polling");
  timer = setInterval(processNextChunk, pollIntervalMS);
}

function stopPolling(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  dexScreenerState$.next("idle");
}

async function processNextChunk(): Promise<void> {
  if (chunks.length === 0) return;

  const cas = chunks[chunkIndex % chunks.length];
  chunkIndex++;

  if (!cas) return;

  const chainId = tracked.values().next().value?.chainId ?? "solana";

  pollBatch(chainId, cas).catch(() => {});
}

async function pollBatch(chainId: string, addresses: string[]): Promise<void> {
  const url = `${dexAPIBaseURL}/${chainId}/${addresses.join(",")}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    dexScreenerState$.next("error");
    return;
  }

  const pairs = (await res.json()) as DexPair[];
  const now = Date.now();

  for (const pair of pairs) {
    const priceUsd = pair.priceUsd ? Number(pair.priceUsd) : NaN;
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) continue;

    const entry = tracked.get(pair.baseToken.address);
    if (!entry) continue;
    if (entry.pairAddress && pair.pairAddress !== entry.pairAddress) continue;

    const priceNative = Number(pair.priceNative);
    const liq = pair.liquidity?.usd ?? 0;

    dexScreenerPriceUpdateEvent$.next({
      token: entry.token,
      pair: pair.pairAddress,
      priceUsd,
      priceNative,
      liquidityUsd: liq,
      marketCap: pair.marketCap ?? null,
      fdv: pair.fdv ?? null,
      dexId: pair.dexId,
      source: PriceSource.DEXSCREENER,
      timestamp: now,
    });
  }
}

// ============================================================================
// Shutdown
// ============================================================================

export function disconnectDexScreener(): void {
  stopPolling();
  tracked.clear();
  chunks = [];
  chunkIndex = 0;
}
