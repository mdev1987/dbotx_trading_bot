import { Subject } from "rxjs";

import type { PriceInfo } from "../data_stream/types";
import type { Position, PositionExitReason } from "./types";
import { clearPendingExit } from "./scanner";
import { getSolPriceUsd } from "../data_stream/price_engine";

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
): Position | null {
  if (!Number.isFinite(entryPriceUsd) || entryPriceUsd <= 0) {
    return null;
  }

  const now = Date.now();

  const position: Position = {
    id: createPositionId(),
    token,
    pair,
    tokenName,

    status: "open",

    openedAt: now,
    lastUpdateAt: now,
    lastPriceTimestamp: now,

    entryPriceUsd,
    currentPriceUsd: entryPriceUsd,
    peakPriceUsd: entryPriceUsd,

    currentProfitPct: 0,

    sizeSol,
    sizeToken: (entryPriceUsd > 0 && getSolPriceUsd() > 0) ? (sizeSol * getSolPriceUsd()) / entryPriceUsd : 0,

    soldPct: 0,
    partialTierIndex: 0,

    renewedAt: now,
    renewPriceUsd: entryPriceUsd,

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
  position.closePriceUsd = closePriceUsd ?? position.currentPriceUsd;
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

  if (update.timestamp <= position.lastPriceTimestamp) {
    return;
  }

  const price = update.priceUsd;

  if (!Number.isFinite(price) || price <= 0) {
    return;
  }

  position.currentPriceUsd = price;
  position.lastPriceTimestamp = update.timestamp;
  position.lastUpdateAt = update.timestamp;
  position.priceSource = update.source;

  if (price > position.peakPriceUsd) {
    position.peakPriceUsd = price;
  }

  position.currentProfitPct = calculateProfit(position.entryPriceUsd, price);

  positionUpdated$.next(position);
}

export function hasPosition(pair: string): boolean {
  return positions.has(pair);
}
