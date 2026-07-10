import type { SimAccount, SwapOrderResult } from "../data_stream/types";

export interface TradingApi {
  buy(
    pair: string,
    amountSol: number,
    tokenName: string,
    tokenCA: string,
  ): Promise<SwapOrderResult>;

  sell(pair: string, amountPercent: number): Promise<SwapOrderResult>;

  getAccountInfo(): Promise<SimAccount>;
}
