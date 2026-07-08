export interface PairSubscription {
  pair: string;
}

export interface PriceUpdate {
  pair: string;

  price: number;

  priceUsd: number;

  marketCap: number;

  timestamp: number;
}

export interface PairInfoMessage {
  type: "pairsInfo";

  result: Array<{
    p: string;
    tp: number;
    tpu: number;
    mp: number;
  }>;
}
