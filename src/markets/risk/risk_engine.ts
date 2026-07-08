import { BehaviorSubject } from "rxjs";

import { CONFIG } from "../../config";

import type { Position, TradeRequest } from "../types/trade";

export interface RiskDecision {
  allowed: boolean;

  reason?: string;

  size: number;
}

export interface RiskState {
  balance: number;

  equity: number;

  realizedPnL: number;

  unrealizedPnL: number;

  peakEquity: number;

  openTrades: number;

  consecutiveLosses: number;

  cooldownUntil: number;
}

const state$ = new BehaviorSubject<RiskState>({
  balance: CONFIG.paperBalance,

  equity: CONFIG.paperBalance,

  realizedPnL: 0,

  unrealizedPnL: 0,

  peakEquity: CONFIG.paperBalance,

  openTrades: 0,

  consecutiveLosses: 0,

  cooldownUntil: 0,
});

const positions = new Map<string, Position>();

export function state(): RiskState {
  return state$.value;
}

export function reset(): void {
  positions.clear();

  state$.next({
    balance: CONFIG.paperBalance,

    equity: CONFIG.paperBalance,

    realizedPnL: 0,

    unrealizedPnL: 0,

    peakEquity: CONFIG.paperBalance,

    openTrades: 0,

    consecutiveLosses: 0,

    cooldownUntil: 0,
  });
}

export function hasPosition(pair: string): boolean {
  return positions.has(pair);
}

export function getPosition(pair: string): Position | undefined {
  return positions.get(pair);
}

export function openPositions(): readonly Position[] {
  return [...positions.values()];
}

export function exposure(): number {
  let total = 0;

  for (const position of positions.values()) {
    total += position.value;
  }

  return total;
}

export function positionSize(price: number): number {
  const risk = state().equity * CONFIG.riskPerTrade;

  return risk / price;
}

export function validate(request: TradeRequest): RiskDecision {
  const current = state();

  if (Date.now() < current.cooldownUntil) {
    return {
      allowed: false,
      reason: "Cooldown active.",
      size: 0,
    };
  }

  if (current.openTrades >= CONFIG.maxOpenTrades) {
    return {
      allowed: false,
      reason: "Maximum open trades reached.",
      size: 0,
    };
  }

  if (hasPosition(request.pair)) {
    return {
      allowed: false,
      reason: "Position already exists.",
      size: 0,
    };
  }

  const drawdown = (current.peakEquity - current.equity) / current.peakEquity;

  if (drawdown >= CONFIG.maxDrawdown) {
    return {
      allowed: false,
      reason: "Maximum drawdown exceeded.",
      size: 0,
    };
  }

  if (
    Math.abs(current.realizedPnL) >= CONFIG.dailyLossLimit &&
    current.realizedPnL < 0
  ) {
    return {
      allowed: false,
      reason: "Daily loss limit reached.",
      size: 0,
    };
  }

  if (exposure() >= CONFIG.maxExposure) {
    return {
      allowed: false,
      reason: "Maximum exposure reached.",
      size: 0,
    };
  }

  if (request.stopLoss && request.stopLoss >= request.entryPrice) {
    return {
      allowed: false,
      reason: "Invalid stop loss.",
      size: 0,
    };
  }

  if (request.takeProfit && request.takeProfit <= request.entryPrice) {
    return {
      allowed: false,
      reason: "Invalid take profit.",
      size: 0,
    };
  }

  const size = positionSize(request.entryPrice);

  return {
    allowed: true,
    size,
  };
}

export { state$ };

export function open(position: Position): void {
  positions.set(position.pair, position);

  const current = state();

  state$.next({
    ...current,
    openTrades: current.openTrades + 1,
  });
}

export function close(pair: string, exitPrice: number): number {
  const position = positions.get(pair);

  if (!position) {
    return 0;
  }

  positions.delete(pair);

  const pnl = (exitPrice - position.entryPrice) * position.quantity;

  const current = state();

  const balance = current.balance + pnl;

  const equity = balance + current.unrealizedPnL;

  state$.next({
    ...current,
    balance,
    equity,
    realizedPnL: current.realizedPnL + pnl,
    peakEquity: Math.max(current.peakEquity, equity),
    openTrades: current.openTrades - 1,
    consecutiveLosses: pnl < 0 ? current.consecutiveLosses + 1 : 0,
    cooldownUntil:
      pnl < 0 && current.consecutiveLosses + 1 >= CONFIG.maxConsecutiveLosses
        ? Date.now() + CONFIG.cooldownMs
        : current.cooldownUntil,
  });

  return pnl;
}

export function updateUnrealizedPnL(value: number): void {
  const current = state();

  const equity = current.balance + value;

  state$.next({
    ...current,
    unrealizedPnL: value,
    equity,
    peakEquity: Math.max(current.peakEquity, equity),
  });
}

export function updatePositionPrice(pair: string, price: number): void {
  const position = positions.get(pair);

  if (!position) {
    return;
  }

  position.lastPrice = price;

  position.value = price * position.quantity;
}

export function canTrade(): boolean {
  const current = state();

  return (
    current.openTrades < CONFIG.maxOpenTrades &&
    Date.now() >= current.cooldownUntil
  );
}

export const riskEngine = {
  state,

  state$,

  reset,

  validate,

  canTrade,

  positionSize,

  exposure,

  hasPosition,

  getPosition,

  openPositions,

  open,

  close,

  updatePositionPrice,

  updateUnrealizedPnL,
};
