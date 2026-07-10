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

export interface PriceUpdate {
  pair: string;
  token: string;
  priceUsd: number;
  timestamp: number;
}

export interface PumpEvent {
  mint: string;
  action: "buy" | "sell";
  price: string;
  timestamp: number;
}
