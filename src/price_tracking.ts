import { Subscription } from "rxjs";

import { CONFIG } from "./config";
import { telegramSignal$ } from "./telegram/telegram_client";
import { trackToken, untrackToken, unifiedPriceUpdate$ } from "./data_stream/price_engine";
import type { PriceInfo } from "./data_stream/types";
import type { AveScannerSignal } from "./telegram/ave_scanner_parser";

/* -------------------------------------------------------------------------- */
/*                                   Types                                    */
/* -------------------------------------------------------------------------- */

interface TrackedSignal {
  token: string;
  pair: string;
  tokenName: string;
  entryPrice: number;
  marketCap?: number;
  liquidity?: number;
  dex?: string;
  lastPrice: number;
  peakPrice: number;
  lowPrice: number;
  lastNotifiedPct: number;
  trackedAt: number;
  lastUpdateAt: number;
}

/* -------------------------------------------------------------------------- */
/*                                   State                                    */
/* -------------------------------------------------------------------------- */

const trackedSignals = new Map<string, TrackedSignal>();

const PRICE_CHANGE_NOTIFY_PCT = 0.05;
const TRACKING_TTL_MS = 3_600_000;
const DEBUG = CONFIG.logLevel === "debug";

let signalSub: Subscription | null = null;
let priceSub: Subscription | null = null;
let cleanupSub: ReturnType<typeof setInterval> | null = null;

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

function fmtPrice(price: number): string {
  if (price >= 1) return `$${price.toFixed(4)}`;
  if (price >= 0.001) return `$${price.toFixed(6)}`;
  if (price >= 0.000001) return `$${price.toFixed(9)}`;
  return `$${price.toFixed(12)}`;
}

function fmtPct(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(2)}%`;
}

function now(): number {
  return Date.now();
}

/* -------------------------------------------------------------------------- */
/*                             Cleanup Old Tracks                             */
/* -------------------------------------------------------------------------- */

function cleanupExpired(): void {
  const cutoff = now() - TRACKING_TTL_MS;

  for (const [token, tracked] of trackedSignals) {
    if (tracked.trackedAt < cutoff) {
      untrackToken(token);
      trackedSignals.delete(token);
      console.log(`[PriceTracker] Expired tracking for ${tracked.tokenName} (${token})`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                              Signal Handler                                */
/* -------------------------------------------------------------------------- */

function onSignal(signal: AveScannerSignal): void {
  cleanupExpired();

  const token = signal.CA;
  const pair = signal.LP;

  if (!token || !pair) return;

  if (trackedSignals.has(token)) return;

  const tokenName = signal.Token ?? token.slice(0, 8);
  const entryPrice = signal.initPriceUSD ?? 0;

  if (entryPrice <= 0) return;

  trackToken(token, pair);

  trackedSignals.set(token, {
    token,
    pair,
    tokenName,
    entryPrice,
    marketCap: signal.marketCapUSD,
    liquidity: signal.LiquidityUSD,
    dex: signal.dex,
    lastPrice: entryPrice,
    peakPrice: entryPrice,
    lowPrice: entryPrice,
    lastNotifiedPct: 0,
    trackedAt: now(),
    lastUpdateAt: now(),
  });

  console.log(
    `[PriceTracker] Tracking ${tokenName}: entry=${fmtPrice(entryPrice)}` +
      (signal.marketCapUSD ? ` mcap=$${(signal.marketCapUSD / 1e6).toFixed(2)}M` : "") +
      (signal.dex ? ` dex=${signal.dex}` : ""),
  );
}

/* -------------------------------------------------------------------------- */
/*                             Price Update Handler                           */
/* -------------------------------------------------------------------------- */

function onPriceUpdate(update: PriceInfo): void {
  const tracked = trackedSignals.get(update.token);

  if (!tracked) return;

  tracked.lastPrice = update.priceUsd;
  tracked.lastUpdateAt = now();

  if (update.priceUsd > tracked.peakPrice) {
    tracked.peakPrice = update.priceUsd;
  }
  if (update.priceUsd < tracked.lowPrice) {
    tracked.lowPrice = update.priceUsd;
  }

  const currentProfit = (update.priceUsd - tracked.entryPrice) / tracked.entryPrice;
  const changeSinceNotify = Math.abs(currentProfit - tracked.lastNotifiedPct);

  if (changeSinceNotify < PRICE_CHANGE_NOTIFY_PCT) return;

  tracked.lastNotifiedPct = currentProfit;

  if (!DEBUG) return;

  const peakProfit = (tracked.peakPrice - tracked.entryPrice) / tracked.entryPrice;
  const drawdown = (tracked.lastPrice - tracked.peakPrice) / tracked.peakPrice;

  const label = currentProfit >= 0 ? "🟢" : "🔴";
  const dd =
    drawdown < 0 ? ` dd=${fmtPct(drawdown)}` : "";

  console.log(
    `[PriceTracker] ${label} ${tracked.tokenName}: ` +
      `cur=${fmtPrice(update.priceUsd)} ` +
      `pnl=${fmtPct(currentProfit)} ` +
      `peak=${fmtPrice(tracked.peakPrice)} (${fmtPct(peakProfit)})` +
      dd +
      ` age=${Math.floor((now() - tracked.trackedAt) / 60000)}m`,
  );
}

/* -------------------------------------------------------------------------- */
/*                                Lifecycle                                   */
/* -------------------------------------------------------------------------- */

export function startPriceTracking(): void {
  if (signalSub) return;

  signalSub = telegramSignal$.subscribe(onSignal);
  priceSub = unifiedPriceUpdate$.subscribe(onPriceUpdate);
  cleanupSub = setInterval(cleanupExpired, 60_000);

  console.log("[PriceTracker] Started");
}

export function stopPriceTracking(): void {
  signalSub?.unsubscribe();
  priceSub?.unsubscribe();
  if (cleanupSub) {
    clearInterval(cleanupSub);
    cleanupSub = null;
  }

  for (const token of trackedSignals.keys()) {
    untrackToken(token);
  }
  trackedSignals.clear();

  console.log("[PriceTracker] Stopped");
}
