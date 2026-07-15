import { BehaviorSubject, Subject } from "rxjs";

import type {
  PriceCurrency,
  PriceInfo,
  PriceSource,
} from "../data_stream/types";

import type { Position, PositionExitReason } from "./types";

// ============================================================================
// Repository State
// ============================================================================

/**
 * Active positions indexed by trading pair.
 *
 * The repository is the single source of truth for all open positions.
 */
const positions = new Map<string, Position>();

/**
 * Sequential position identifier.
 */
let nextPositionId = 1;

// ============================================================================
// Reactive Events
// ============================================================================

/**
 * Emits whenever a position is created or updated.
 */
export const positionUpdated$ = new Subject<Position>();

/**
 * Emits the complete list of open positions whenever the repository changes.
 *
 * Useful for dashboards and terminal UIs.
 */
export const positions$ = new BehaviorSubject<ReadonlyMap<string, Position>>(
  positions,
);

// ============================================================================
// Helpers
// ============================================================================

/**
 * Publishes repository changes.
 */
function publish(position: Position): void {
  positionUpdated$.next(position);

  positions$.next(new Map(positions));
}

/**
 * Generates the next position identifier.
 */
function createPositionId(): string {
  return `pos-${nextPositionId++}`;
}

/**
 * Calculates the unrealized profit percentage.
 */
function calculateProfit(entryPrice: number, currentPrice: number): number {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    return 0;
  }

  return (currentPrice - entryPrice) / entryPrice;
}

/**
 * Returns true if a price is valid.
 */
function isValidPrice(price: number): boolean {
  return Number.isFinite(price) && price > 0;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Returns a read-only view of all open positions.
 */
export function getPositions(): ReadonlyMap<string, Position> {
  return positions;
}

/**
 * Returns a position by trading pair.
 */
export function getPosition(pair: string): Position | undefined {
  return positions.get(pair);
}

/**
 * Returns true if an open position exists.
 */
export function hasPosition(pair: string): boolean {
  return positions.has(pair);
}

/**
 * Creates and stores a new trading position.
 *
 * Returns null when the supplied parameters are invalid.
 */
export function addPosition(
  token: string,
  pair: string,
  tokenName: string,
  entryPrice: number,
  sizeSol: number,
  signalMeta?: {
    marketCapUSD?: number;
    dex?: string;
  },
  priceCurrency: PriceCurrency = "USD",
): Position | null {
  if (!Number.isFinite(sizeSol) || sizeSol <= 0) {
    return null;
  }

  const now = Date.now();

  const hasEntry = isValidPrice(entryPrice);

  const position: Position = {
    id: createPositionId(),

    token,
    pair,
    tokenName,

    status: "open",

    openedAt: now,
    lastUpdateAt: now,
    lastPriceTimestamp: now,

    entryPrice: hasEntry ? entryPrice : 0,
    currentPrice: hasEntry ? entryPrice : 0,
    peakPrice: hasEntry ? entryPrice : 0,

    currentProfitPct: 0,

    sizeSol,
    sizeToken: hasEntry ? sizeSol / entryPrice : 0,

    soldPct: 0,
    partialTierIndex: 0,

    renewedAt: now,
    renewPrice: hasEntry ? entryPrice : 0,

    priceCurrency,

    signalMeta,
  };

  positions.set(pair, position);

  publish(position);

  return position;
}

/**
 * Removes a position from the repository.
 *
 * The position is marked as closed before being removed so subscribers
 * receive one final update.
 */
export function removePosition(
  pair: string,
  closePrice?: number,
  reason?: PositionExitReason,
): Position | null {
  const position = positions.get(pair);

  if (!position) {
    return null;
  }

  const now = Date.now();

  position.status = "closed";
  position.reason = reason;
  position.closedAt = now;
  position.lastUpdateAt = now;

  position.closePrice = isValidPrice(closePrice ?? NaN)
    ? closePrice
    : position.currentPrice;

  publish(position);

  positions.delete(pair);

  return position;
}

/**
 * Removes every open position.
 */
export function clearPositions(): void {
  positions.clear();

  positions$.next(new Map(positions));

  nextPositionId = 1;
}

// ============================================================================
// Price Updates
// ============================================================================

/**
 * Initializes a position once its first valid market price arrives.
 *
 * This allows positions created before the first market tick to become
 * fully initialized without special handling elsewhere.
 */
function initializePositionPrice(position: Position, update: PriceInfo): void {
  position.entryPrice = update.priceUsd;
  position.currentPrice = update.priceUsd;
  position.peakPrice = update.priceUsd;
  position.renewPrice = update.priceUsd;
  position.renewedAt = update.timestamp;

  position.currentProfitPct = 0;

  position.lastPriceTimestamp = update.timestamp;
  position.lastUpdateAt = update.timestamp;

  position.priceSource = update.source;
  position.priceCurrency = update.currency;
}

/**
 * Applies a normal market price update.
 */
function applyPriceUpdate(position: Position, update: PriceInfo): void {
  position.currentPrice = update.priceUsd;

  position.lastPriceTimestamp = update.timestamp;
  position.lastUpdateAt = update.timestamp;

  position.priceSource = update.source;
  position.priceCurrency = update.currency;

  if (update.priceUsd > position.peakPrice) {
    position.peakPrice = update.priceUsd;
  }

  position.currentProfitPct = calculateProfit(
    position.entryPrice,
    update.priceUsd,
  );
}

/**
 * Updates the latest market price for a position.
 *
 * Invalid or stale price updates are ignored.
 */
export function updatePositionPrice(update: PriceInfo): void {
  const position =
    positions.get(update.pair ?? "") ?? positions.get(update.token);

  if (!position) {
    return;
  }

  if (!isValidPrice(update.priceUsd)) {
    return;
  }

  // Ignore stale market updates.
  if (update.timestamp <= position.lastPriceTimestamp) {
    return;
  }

  // Position created before the first price arrived.
  if (position.entryPrice <= 0) {
    initializePositionPrice(position, update);

    publish(position);

    return;
  }

  applyPriceUpdate(position, update);

  publish(position);
}
