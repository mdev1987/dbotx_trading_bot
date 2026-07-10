import type { PriceSource } from "../data_stream/types";

export enum PositionExitReason {
  StopLoss = "stop_loss",
  TrailingStop = "trailing_stop",
  Expired = "expired",
  PartialTP = "partial_tp",
  TakeProfit = "take_profit",
  Manual = "manual",
}

export interface PerformanceReport {
  openPositions: number;
  closedPositions: number;
  totalPositions: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalProfitPct: number;
  totalProfitUsd: number;
  bestTradePct: number;
  worstTradePct: number;
  avgProfitPct: number;
  avgProfitUsd: number;
  reasons: Record<string, number>;
}

export interface Position {
  id: string;
  orderId: string;
  pair: string;
  token: string;
  tokenName: string;
  entryPriceUsd: number;
  sizeSol: number;
  sizeToken: number;
  openedAt: number;
  peakPriceUsd: number;
  currentPriceUsd: number;
  soldPct: number;
  status: "open" | "closed";
  closeReason?: string;
  closePriceUsd?: number;
  closedAt?: number;
  lastUpdateAt: number;
  currentProfitPct: number;
  partialTierIndex: number;
  priceSource?: PriceSource;
  lastPriceTimestamp: number;
  reason?: PositionExitReason;
}
