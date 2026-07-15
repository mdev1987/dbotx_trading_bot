export enum PriceSource {
  DBOTX = "dbotx",
  PUMPAPI = "pumpapi",
  DEXSCREENER = "dexscreener",
}

export type PriceCurrency = "SOL" | "USD";

export interface PriceInfo {
  token: string;
  pair?: string;
  priceUsd: number;
  source: PriceSource;
  timestamp: number;
  currency: PriceCurrency;
}

export interface DbotxEvent {
  pair: string;
  token: string;
  priceUsd: number;
  priceSol: number;
  source: PriceSource;
  timestamp: number;
}

export interface PumpEvent {
  mint: string;
  action: "buy" | "sell";
  price: string;
  quoteMint: string;
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

export interface DbotxTrade {
  p: string;
  tt: "buy" | "sell";
  s: number;
  u: number;
  q: number;
  t: number;
  tx: string;
}

export interface DbotxWsPacket {
  type?: string;
  result?: DbotxTrade[];
  status?: string;
}

export interface PumpWsPacket {
  type?: string;
  mint?: string;
  action?: string;
  price?: string;
  quoteMint?: string;
}
