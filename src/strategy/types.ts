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
  pair: string;
  token: string;
  tokenName: string;

  entryPriceUsd: number;
  sizeSol: number;
  sizeToken: number;

  openedAt: number;
  currentPriceUsd: number;
  peakPriceUsd: number;

  soldPct: number;
  partialTierIndex: number;

  status: "open" | "closed";
  reason?: PositionExitReason;
  closePriceUsd?: number;
  closedAt?: number;

  renewedAt: number;
  renewPriceUsd: number;

  lastUpdateAt: number;
  currentProfitPct: number;
  priceSource?: PriceSource;
  lastPriceTimestamp: number;
}
