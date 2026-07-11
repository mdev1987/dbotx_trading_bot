export interface OrderResult {
  id: string;
  status: string;
  pair: string;
  type: "buy" | "sell";
  priceUsd?: number;
  amountSol?: number;
  amountToken?: number;
  txHash?: string;
  error?: string;
  updatedAt: number;
}

export interface TradingAccount {
  balance: number;
  change24h: number;
  changeAll: number;
  holdTokens: number;
}

export interface TradingApi {
  buy(
    pair: string,
    amountSol: number,
    tokenName: string,
    token: string,
  ): Promise<OrderResult>;

  sell(
    pair: string,
    percentage: number,
    tokenName: string,
    token: string,
  ): Promise<OrderResult>;

  getAccount(): Promise<TradingAccount>;

  shutdown(): Promise<void>;
}
