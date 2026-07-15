export enum PriceSource {
  DBOTX = "dbotx",
  PUMPAPI = "pumpapi",
  PUMPDEV = "pumpdev",
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
  priceNative: number;
  liquidityUsd: number;
  marketCap: number | null;
  fdv: number | null;
  dexId: string;
  source: PriceSource;
  timestamp: number;
}

export interface PumpDevEvent {
  mint: string;
  txType: "buy" | "sell" | "create" | "complete" | "create_pool";
  quoteMint: string;
  quoteAmount: number | null;
  solAmount: number | null;
  tokenAmount: number;
  marketCapQuote: number | null;
  marketCapSol: number | null;
  traderPublicKey: string;
  signature: string;
  source?: string;
  pool?: string;
  bondingCurveKey?: string;
  vTokensInBondingCurve?: number;
  vQuoteInBondingCurve?: number;
  vSolInBondingCurve?: number;
  poolBaseReserves?: number;
  poolBaseReservesUi?: number;
  poolQuoteReserves?: number;
  poolQuoteReservesUi?: number | null;
  priceSol: number;
  priceUsd: number;
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
  liquidity?: { usd: number; base: number; quote: number };
  fdv?: number;
  marketCap?: number;
  labels?: string[] | null;
  pairCreatedAt?: number | null;
  info?: { imageUrl?: string; websites?: { url: string }[]; socials?: { platform: string; handle: string }[] };
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
