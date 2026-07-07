import type { Observable } from "rxjs";
import type { ParsedSignal } from "../telegram/telegram_listener";
import type { PositionState, CloseReason } from "./types";

export interface IExchangeService {
  buy(pair: string, amountSol: number, signal?: ParsedSignal): Promise<string>;
  sell(pair: string): Promise<string>;
  queryOrder(orderId: string): Promise<{ state: string; txPriceUsd?: number } | null>;
  queryOrders(orderIds: string[]): Promise<{ id: string; state: string; txPriceUsd?: number }[]>;
}

export interface IPersistenceService {
  savePosition(pos: PositionState): void;
  loadNonClosed(): Promise<PositionState[]>;
  loadAll(): PositionState[];
  deletePosition(positionId: number): void;
}

export interface IAccountService {
  computePositionSize(signal?: ParsedSignal): number;
  getBalance(): number;
  refreshBalance(): void;
}

export interface IMarketDataService {
  pairUpdate$: Observable<{ pair: string; priceUsd: number; token?: string }>;
}

export interface IRiskManager {
  isBuyAllowed(signal: ParsedSignal): boolean;
  recordBuy(): void;
  recordLoss(profitUsd: number, profitPercent: number): void;
  totalSolDeployed(): number;
  checkCooldown(): boolean;
}

export interface ITrailingMonitor {
  evaluatePosition(pos: PositionState, currentPrice: number): CloseReason | null;
}

export interface ITpSlBuilder {
  buildTpSlTiers(signal?: ParsedSignal): { pricePercent: number; amountPercent: number }[];
  buildStopLossPercent(): number | undefined;
}
