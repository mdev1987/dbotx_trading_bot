export interface RiskConfig {
  takeProfitPercent: number;

  stopLossPercent: number;

  trailingTriggerPercent: number;

  trailingDistancePercent: number;

  ttlSeconds: number;

  emergencyLossPercent: number;
}

export interface Position {
  pair: string;

  quantity: number;

  entryPrice: number;

  highestPrice: number;

  openedAt: number;
}

export type RiskEventType = "tp" | "sl" | "trailing" | "ttl" | "emergency";

export interface RiskEvent {
  type: RiskEventType;

  pair: string;

  currentPrice: number;

  timestamp: number;
}
