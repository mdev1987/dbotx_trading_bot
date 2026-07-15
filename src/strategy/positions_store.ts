import { Subject } from "rxjs";

import type { PriceCurrency, PriceInfo } from "../data_stream/types";
import type { Position, PositionExitReason } from "./types";
import { clearPendingExit } from "./scanner";

const positions = new Map<string, Position>();

let nextPositionId = 1;

export { positions };

export const positionUpdated$ = new Subject<Position>();

function publishPositions(position: Position): void {
  positionUpdated$.next(position);
}

function createPositionId(): string {
  return `pos_${nextPositionId++}`;
}

function calculateProfit(entry: number, current: number): number {
  if (!Number.isFinite(entry) || entry <= 0) return 0;
  return (current - entry) / entry;
}

export function addPosition(
  token: string,
  pair: string,
  tokenName: string,
  entryPriceUsd: number,
  sizeSol: number,
  signalMeta?: { marketCapUSD?: number; dex?: string },
  priceCurrency: PriceCurrency = "USD",
): Position | null {
  if (!Number.isFinite(sizeSol) || sizeSol <= 0) {
    return null;
  }

  const now = Date.now();
  const hasEntry = Number.isFinite(entryPriceUsd) && entryPriceUsd > 0;

  const position: Position = {
    id: createPositionId(),
    token,
    pair,
    tokenName,

    status: "open",

    openedAt: now,
    lastUpdateAt: now,
    lastPriceTimestamp: now,

    entryPrice: hasEntry ? entryPriceUsd : 0,
    currentPrice: hasEntry ? entryPriceUsd : 0,
    peakPrice: hasEntry ? entryPriceUsd : 0,

    currentProfitPct: 0,

    sizeSol,
    sizeToken: hasEntry ? sizeSol / entryPriceUsd : 0,

    soldPct: 0,
    partialTierIndex: 0,

    renewedAt: now,
    renewPrice: hasEntry ? entryPriceUsd : 0,

    priceCurrency,

    signalMeta,
  };

  positions.set(pair, position);

  publishPositions(position);

  return position;
}

export function removePosition(
  pair: string,
  closePriceUsd?: number,
  reason?: PositionExitReason,
): Position | null {
  const position = positions.get(pair);

  if (!position) {
    return null;
  }

  position.status = "closed";
  position.closePrice = closePriceUsd ?? position.currentPrice;
  position.reason = reason;
  position.closedAt = Date.now();
  position.lastUpdateAt = Date.now();

  publishPositions(position);

  positions.delete(pair);

  clearPendingExit(position.id);

  return position;
}

export function updatePositionPrice(update: PriceInfo): void {
  const position =
    positions.get(update.pair ?? "") ?? positions.get(update.token);

  if (!position) {
    return;
  }

  const price = update.priceUsd;

  if (!Number.isFinite(price) || price <= 0) {
    return;
  }

  if (position.entryPrice <= 0) {
    position.entryPrice = price;
    position.currentPrice = price;
    position.peakPrice = price;
    position.renewPrice = price;
    position.currentProfitPct = 0;
    position.lastPriceTimestamp = update.timestamp;
    position.lastUpdateAt = update.timestamp;
    position.priceSource = update.source;
    position.priceCurrency = update.currency;
    positionUpdated$.next(position);
    return;
  }

  if (update.timestamp <= position.lastPriceTimestamp) {
    return;
  }

  position.currentPrice = price;
  position.lastPriceTimestamp = update.timestamp;
  position.lastUpdateAt = update.timestamp;
  position.priceSource = update.source;
  position.priceCurrency = update.currency;

  if (price > position.peakPrice) {
    position.peakPrice = price;
  }

  position.currentProfitPct = calculateProfit(position.entryPrice, price);

  positionUpdated$.next(position);
}

export function hasPosition(pair: string): boolean {
  return positions.has(pair);
}
