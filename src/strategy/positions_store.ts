import { BehaviorSubject, Subject } from "rxjs";

import type { PriceInfo } from "../data_stream/types";
import type { Position, PositionExitReason } from "./types";
import { clearPendingExit } from "./scanner";

const positions = new Map<string, Position>();
const closedPositions: Position[] = [];

let nextPositionId = 1;

export { positions };

export const openPositions$ = new BehaviorSubject<readonly Position[]>([]);

export const positionOpened$ = new Subject<Position>();

export const positionUpdated$ = new Subject<Position>();

export const positionClosed$ = new Subject<Position>();

function publishPositions(): void {
  openPositions$.next([...positions.values()]);
}

function createPositionId(): string {
  return `pos_${nextPositionId++}`;
}

function calculateProfit(entry: number, current: number): number {
  return (current - entry) / entry;
}

export function addPosition(
  token: string,
  pair: string,
  tokenName: string,
  entryPriceUsd: number,
  sizeSol: number,
): Position {
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
    sizeToken: sizeSol / entryPriceUsd,

    soldPct: 0,
    partialTierIndex: 0,
  };

  positions.set(pair, position);

  publishPositions();

  positionOpened$.next(position);

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

  positions.delete(pair);

  closedPositions.push(position);

  publishPositions();

  positionClosed$.next(position);

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

export function getPosition(pair: string): Position | undefined {
  return positions.get(pair);
}

export function hasPosition(pair: string): boolean {
  return positions.has(pair);
}

export function getOpenPositions(): readonly Position[] {
  return [...positions.values()];
}

export function getClosedPositions(): readonly Position[] {
  return closedPositions;
}

export function positionCount(): number {
  return positions.size;
}

export function clearPositions(): void {
  positions.clear();

  closedPositions.length = 0;

  publishPositions();
}
