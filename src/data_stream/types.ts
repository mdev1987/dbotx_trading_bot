export enum PriceSource {
  DBOTX = "dbotx",
  PUMPAPI = "pumpapi",
  DEXSCREENER = "dexscreener",
}

export interface PriceInfo {
  token: string;
  pair?: string;
  priceUsd: number;
  source: PriceSource;
  timestamp: number;
}

export interface DbotxEvent {
  pair: string;
  token: string;
  priceUsd: number;
  source: PriceSource;
  timestamp: number;
}

export interface PumpEvent {
  mint: string;
  action: "buy" | "sell";
  price: string;
  source: PriceSource;
  timestamp: number;
}

export interface DexScreenerEvent {
  token: string;
  pair: string;
  priceUsd: number;
  source: PriceSource;
  timestamp: number;
}

export interface TrackedToken {
  pair: string;
  timestamp: number;
}

export interface DexPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; symbol: string; name: string };
  quoteToken: { address: string; symbol: string };
  priceUsd: string;
  priceNative: string;
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
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
