import type { SimAccount, SwapOrderResult } from "../data_stream/types";

export interface TradingApi {
  /** Submit a buy order and return the order ID (fast, no polling) */
  submitBuy(
    pair: string,
    amountSol: number,
    tokenName: string,
    tokenCA: string,
  ): Promise<string>;

  /** Poll until the order completes and return the result */
  waitForOrder(orderId: string): Promise<SwapOrderResult>;

  sell(pair: string, amountPercent: number): Promise<SwapOrderResult>;

  getAccountInfo(): Promise<SimAccount>;
}

/** Convenience: submitBuy + waitForOrder */
export async function buyWithPoll(
  api: TradingApi,
  pair: string,
  amountSol: number,
  tokenName: string,
  tokenCA: string,
): Promise<SwapOrderResult> {
  const id = await api.submitBuy(pair, amountSol, tokenName, tokenCA);
  return api.waitForOrder(id);
}
