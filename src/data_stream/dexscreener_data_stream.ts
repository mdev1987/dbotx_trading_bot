import { Subject } from "rxjs";

import { PriceSource, type DexPair, type DexScreenerEvent } from "./types";

// ============================================================================
// Public Streams
// ============================================================================

export const dexScreenerPriceUpdateEvent$ = new Subject<DexScreenerEvent>();

export type DexConnectionState = "idle" | "polling" | "error";
export const dexScreenerState$ = new Subject<DexConnectionState>();

// ============================================================================
// Internal State
// ============================================================================

const API_BASE = "https://api.dexscreener.com/token-pairs/v1";

// Rate limit: 300 req/min = 5 req/s = 1 req per 200ms max.
// A rotating queue ensures 1 request fires every 200ms regardless of token count.
// With N tokens each is polled every N × 200ms (e.g. 1s for 5 tokens).
const POLL_INTERVAL_MS = 200;

interface TrackEntry {
  chainId: string;
  token: string;
  pairAddress?: string;
}

const tracked = new Map<string, TrackEntry>();
const queue: TrackEntry[] = [];

let timer: ReturnType<typeof setTimeout> | null = null;

// ============================================================================
// Public API
// ============================================================================

export function subscribeToken(
  token: string,
  chainId = "solana",
  pairAddress?: string,
): void {
  if (tracked.has(token)) return;
  const entry: TrackEntry = { chainId, token, pairAddress };
  tracked.set(token, entry);
  queue.push(entry);
  if (tracked.size === 1) startPolling();
}

export function unsubscribeToken(token: string): void {
  const entry = tracked.get(token);
  if (!entry) return;
  tracked.delete(token);
  const idx = queue.indexOf(entry);
  if (idx !== -1) queue.splice(idx, 1);
  if (tracked.size === 0) stopPolling();
}

// ============================================================================
// Polling — rotating queue, 1 request every 200ms
// ============================================================================

function startPolling(): void {
  if (timer) return;
  dexScreenerState$.next("polling");
  scheduleNext();
}

function stopPolling(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  dexScreenerState$.next("idle");
}

function scheduleNext(): void {
  timer = setTimeout(processNext, POLL_INTERVAL_MS);
}

async function processNext(): Promise<void> {
  if (queue.length === 0) {
    scheduleNext();
    return;
  }

  const entry = queue.shift()!;
  queue.push(entry);

  pollToken(entry).catch(() => {});

  scheduleNext();
}

async function pollToken(entry: TrackEntry): Promise<void> {
  const url = `${API_BASE}/${entry.chainId}/${entry.token}`;
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
  queue.length = 0;
}
