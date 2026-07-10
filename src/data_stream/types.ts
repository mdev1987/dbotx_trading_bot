export enum PriceSource {
  DBOTX = "dbotx",
  PUMP = "pump",
  DEX = "dex",
}

export interface PriceInfo {
  token: string;
  pair?: string;
  priceUsd: number;
  source: PriceSource;
  timestamp: number;
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
}

export interface SimAccount {
  balance: number;
  change24h: number;
  changeAll: number;
  holdTokens: number;
}

export interface SwapOrderResult {
  id: string;
  state: string;
  type?: string;
  pair?: string;
  priceUsd?: number;
  totalUsd?: number;
  sendAmount?: string;
  receiveAmount?: string;
}

export interface PositionEvent {
  type: "opened" | "closed" | "partial_sold";
  position: Position;
  soldPct?: number;
  profitPct?: number;
  reason?: string;
}
