import type { Observable } from "rxjs";
import type { ParsedSignal } from "../telegram/telegram_listener";
import type { PositionState, CloseReason } from "./types";

/** Interface for exchange interactions — buy, sell, and order queries */
export interface IExchangeService {
  /** Place a buy order for the given pair */
  buy(pair: string, amountSol: number, signal?: ParsedSignal): Promise<string>;
  /** Place a sell/market order for the given pair */
  sell(pair: string): Promise<string>;
  /** Query a single order's state by ID */
  queryOrder(orderId: string): Promise<{ state: string; txPriceUsd?: number } | null>;
  /** Batch query multiple orders by their IDs */
  queryOrders(orderIds: string[]): Promise<{ id: string; state: string; txPriceUsd?: number }[]>;
}

/** Interface for persisting and loading position state */
export interface IPersistenceService {
  /** Persist a single position snapshot */
  savePosition(pos: PositionState): void;
  /** Load all positions that are not fully closed */
  loadNonClosed(): Promise<PositionState[]>;
  /** Load every known position */
  loadAll(): PositionState[];
  /** Remove a position by its ID */
  deletePosition(positionId: number): void;
}

/** Interface for account balance and position sizing */
export interface IAccountService {
  /** Calculate how much SOL to allocate for a new position */
  computePositionSize(signal?: ParsedSignal): number;
  /** Get the current account balance in SOL */
  getBalance(): number;
  /** Force-refresh the cached balance from the exchange */
  refreshBalance(): void;
}

/** Interface for streaming market price data */
export interface IMarketDataService {
  /** Observable stream of price updates per trading pair */
  pairUpdate$: Observable<{ pair: string; priceUsd: number; token?: string }>;
}

/** Interface for risk management checks — rate limits, cooldowns, loss limits */
export interface IRiskManager {
  /** Check whether a buy is permitted for the given signal */
  isBuyAllowed(signal: ParsedSignal): boolean;
  /** Record that a buy was executed */
  recordBuy(): void;
  /** Record a loss outcome for cooldown tracking */
  recordLoss(profitUsd: number, profitPercent: number): void;
  /** Total SOL currently deployed in open positions */
  totalSolDeployed(): number;
  /** Check if the system is in cooldown period */
  checkCooldown(): boolean;
}

/** Interface for evaluating trailing stop/tp conditions on a position */
export interface ITrailingMonitor {
  /** Evaluate a position at a given price; returns a CloseReason if it should close */
  evaluatePosition(pos: PositionState, currentPrice: number): CloseReason | null;
}

/** Interface for building take-profit and stop-loss tier configurations */
export interface ITpSlBuilder {
  /** Build an ordered list of TP/SL tiers with price and amount percentages */
  buildTpSlTiers(signal?: ParsedSignal): { pricePercent: number; amountPercent: number }[];
  /** Return the stop-loss percentage, or undefined if not configured */
  buildStopLossPercent(): number | undefined;
}
