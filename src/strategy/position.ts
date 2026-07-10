import { BehaviorSubject, Subject } from "rxjs";
import { CONFIG } from "../config";
import type { PriceInfo } from "../data_stream/types";
import {
  type Position,
  type PerformanceReport,
  PositionExitReason,
} from "./types";

export const closedPositions: Position[] = [];

export const positionPartialSellRequested$ = new Subject<{
  position: Position;
  percentage: number;
}>();

export const positions = new Map<string, Position>();
export const openPositions$ = new BehaviorSubject<readonly Position[]>([]);
export const positionOpened$ = new Subject<Position>();
export const positionUpdated$ = new Subject<Position>();
export const positionClosed$ = new Subject<Position>();
export const positionExitRequested$ = new Subject<{
  position: Position;
  reason: PositionExitReason;
}>();

let nextId = 1;

function publishPositions(): void {
  openPositions$.next([...positions.values()]);
}

function createPositionId(): string {
  return `pos_${nextId++}`;
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
    orderId: "",
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
    soldPct: 0,
    partialTierIndex: 0,
    sizeSol,
    sizeToken: sizeSol / entryPriceUsd,
  };

  positions.set(pair, position);
  publishPositions();
  positionOpened$.next(position);
  return position;
}

export function removePosition(pair: string): Position | null {
  const position = positions.get(pair);
  if (!position) {
    return null;
  }
  position.status = "closed";
  position.lastUpdateAt = Date.now();
  positions.delete(pair);
  publishPositions();
  positionClosed$.next(position);
  return position;
}

export function handlePriceUpdate(update: PriceInfo): void {
  const now = Date.now();

  for (const position of positions.values()) {
    if (position.status !== "open") {
      continue;
    }

    const matches =
      position.token === update.token ||
      position.pair === update.token ||
      (update.pair !== undefined &&
        (position.token === update.pair || position.pair === update.pair));

    if (!matches) {
      continue;
    }

    // Ignore stale updates.
    if (update.timestamp <= position.lastPriceTimestamp) {
      continue;
    }

    const price = update.priceUsd;

    if (!Number.isFinite(price) || price <= 0) {
      continue;
    }

    position.currentPriceUsd = price;
    position.lastPriceTimestamp = update.timestamp;
    position.lastUpdateAt = now;
    position.priceSource = update.source;

    if (price > position.peakPriceUsd) {
      position.peakPriceUsd = price;
    }

    position.currentProfitPct =
      (price - position.entryPriceUsd) / position.entryPriceUsd;

    positionUpdated$.next(position);
  }

  publishPositions();
}

/* -------------------------------------------------------------------------- */
/*                               Price Updates                                */
/* -------------------------------------------------------------------------- */

export function updatePositionPrice(update: PriceInfo): void {
  const position =
    positions.get(update.token) ??
    (update.pair ? positions.get(update.pair) : undefined);

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

  position.currentProfitPct =
    (price - position.entryPriceUsd) / position.entryPriceUsd;

  positionUpdated$.next(position);
}

/* -------------------------------------------------------------------------- */
/*                               Exit Scanner                                 */
/* -------------------------------------------------------------------------- */

export function scanPositions(): void {
  const now = Date.now();

  for (const position of positions.values()) {
    if (position.status !== "open") {
      continue;
    }

    checkStopLoss(position);
    checkTrailingStop(position);
    checkPartialTakeProfit(position);
    checkPositionTTL(position, now);
  }
}

/* -------------------------------------------------------------------------- */
/*                                Stop Loss                                   */
/* -------------------------------------------------------------------------- */

function checkStopLoss(position: Position): void {
  if (position.currentProfitPct > CONFIG.stopLossPct) {
    return;
  }

  positionExitRequested$.next({
    position,
    reason: PositionExitReason.StopLoss,
  });
}

/* -------------------------------------------------------------------------- */
/*                              Trailing Stop                                 */
/* -------------------------------------------------------------------------- */

function checkTrailingStop(position: Position): void {
  const peakProfit =
    (position.peakPriceUsd - position.entryPriceUsd) / position.entryPriceUsd;

  if (peakProfit < CONFIG.trailingActivationPct) {
    return;
  }

  const drawdown = peakProfit - position.currentProfitPct;

  if (drawdown < CONFIG.trailingDistancePct) {
    return;
  }

  positionExitRequested$.next({
    position,
    reason: PositionExitReason.TrailingStop,
  });
}

/* -------------------------------------------------------------------------- */
/*                              Partial Take Profit                           */
/* -------------------------------------------------------------------------- */

function checkPartialTakeProfit(position: Position): void {
  if (!CONFIG.partialTpEnabled) {
    return;
  }

  const tiers = CONFIG.partialTpTiers;

  while (position.partialTierIndex < tiers.length) {
    const tier = tiers[position.partialTierIndex]!;

    if (position.currentProfitPct < tier.at) {
      break;
    }

    positionPartialSellRequested$.next({
      position,
      percentage: tier.pct,
    });

    position.partialTierIndex++;
  }
}

/* -------------------------------------------------------------------------- */
/*                                 TTL                                        */
/* -------------------------------------------------------------------------- */

function checkPositionTTL(position: Position, now: number): void {
  const ageSeconds = (now - position.openedAt) / 1000;

  if (ageSeconds < CONFIG.baseTtlSecs) {
    return;
  }

  if (
    position.currentProfitPct >= CONFIG.minProfitForTtlExtensionPct &&
    ageSeconds < CONFIG.maxTtlSecs
  ) {
    return;
  }

  positionExitRequested$.next({
    position,
    reason: PositionExitReason.Expired,
  });
}

/* -------------------------------------------------------------------------- */
/*                                Queries                                     */
/* -------------------------------------------------------------------------- */

export function getPosition(id: string): Position | undefined {
  return positions.get(id);
}

export function getPositionByToken(token: string): Position | undefined {
  return positions.get(token);
}

export function getPositionByPair(pair: string): Position | undefined {
  for (const position of positions.values()) {
    if (position.pair === pair) {
      return position;
    }
  }

  return undefined;
}

export function hasPosition(token: string): boolean {
  return positions.has(token);
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

/* -------------------------------------------------------------------------- */
/*                               Statistics                                   */
/* -------------------------------------------------------------------------- */

export function getPerformance(): PerformanceReport {
  const closed = getClosedPositions();

  const winners = closed.filter((position) => position.currentProfitPct > 0);

  const losers = closed.filter((position) => position.currentProfitPct <= 0);

  const totalProfitPct = closed.reduce(
    (sum, position) => sum + position.currentProfitPct,
    0,
  );

  const profits = closed.map((position) => position.currentProfitPct);

  return {
    openPositions: positions.size,
    closedPositions: closed.length,
    totalPositions: positions.size + closed.length,

    winningTrades: winners.length,
    losingTrades: losers.length,

    winRate: closed.length === 0 ? 0 : (winners.length / closed.length) * 100,

    totalProfitPct,

    avgProfitPct: profits.length === 0 ? 0 : totalProfitPct / profits.length,

    bestTradePct: profits.length === 0 ? 0 : Math.max(...profits),

    worstTradePct: profits.length === 0 ? 0 : Math.min(...profits),
    avgProfitUsd:
      closed.reduce(
        (sum, pos) =>
          sum + pos.currentProfitPct * pos.sizeToken * pos.entryPriceUsd,
        0,
      ) / (closed.length === 0 ? 1 : closed.length),
    reasons: closed.reduce(
      (acc, pos) => {
        const reason = pos.reason || PositionExitReason.Manual;
        acc[reason] = (acc[reason] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    ),
    totalProfitUsd:
      closed.reduce(
        (sum, pos) =>
          sum + pos.currentProfitPct * pos.sizeToken * pos.entryPriceUsd,
        0,
      ) / (closed.length === 0 ? 1 : closed.length),
  };
}

/* -------------------------------------------------------------------------- */
/*                                 Cleanup                                    */
/* -------------------------------------------------------------------------- */

export function clearPositions(): void {
  positions.clear();
  closedPositions.length = 0;

  openPositions$.next([]);
}

export function resetPositionEngine(): void {
  clearPositions();
}
