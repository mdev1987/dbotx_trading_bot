export type CloseReason =
  | "take_profit"
  | "stop_loss"
  | "trailing_stop"
  | "trailing_tp"
  | "expired"
  | "manual"
  | "pump_message"
  | "backstop_tp";

export type PositionStatus = "open" | "closing" | "closed";

export interface PositionState {
  id: number;
  orderId: string;
  pair: string;
  token: string;
  tokenName: string;
  tokenSymbol: string;
  entryPriceUsd: number | null;
  entryCostUsd: number | null;
  sizeSol: number;
  filledSol: number;
  avgFillPriceUsd: number | null;
  peakPriceUsd: number;
  trailingActive: boolean;
  currentProfitPercent: number;
  currentProfitUsd: number;
  remainingBalance: string;
  openedAt: number;
  expiresAt: number;
  lastUpdateAt: number;
  status: PositionStatus;
  closeReason: CloseReason | null;
  exitPriceUsd: number | null;
  signal: ParsedSignal;
}

export interface PositionEvent {
  type: "opened" | "updated" | "closing" | "closed";
  position: PositionState;
  closeReason?: CloseReason;
  detail?: string;
}

export interface PriceUpdate {
  pair: string;
  token: string;
  priceUsd: number;
  timestamp: number;
}

export interface ParsedSignal {
  tokenName: string;
  contractAddress: string;
  lpAddress: string;
  chain: string;
  initPriceRaw?: string;
  initPrice?: number;
  marketCapRaw?: string;
  marketCapUsd?: number;
  tokenAddress?: string;
  maxPumpX?: number;
  walletBuyCount?: number;
  totalBuySol?: number;
  fromDEX?: string;
  nVibeSignal?: number;
  type?: string;
  raw?: string;
}

export interface PerformanceReport {
  totalPositions: number;
  closedPositions: number;
  openPositions: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalProfitUsd: number;
  totalProfitPct: number;
  avgProfitPct: number;
  avgProfitUsd: number;
  bestTradePct: number;
  worstTradePct: number;
  reasons: Record<string, number>;
}
