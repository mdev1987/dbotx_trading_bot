import {
  submitBuy,
  submitSell,
  SimulatorOrderStatus,
  type SimulatorOrder,
} from "./orders";

import type { SimulatorTask } from "./tasks";

import {
  refreshSimulatorAccount,
  getSimulatorAccount,
  resetSimulatorAccount,
} from "./account";

import type {
  OrderResult,
  TradingAccount,
  TradingApi,
} from "../../types";

async function execute(
  orderPromise: Promise<SimulatorOrder>,
): Promise<SimulatorTask> {
  const order = await orderPromise;

  console.log(`[SimTrading] Submitted ${order.type} ${order.id} (simulator)`);
  await refreshSimulatorAccount();

  return {
    id: order.id,
    status: SimulatorOrderStatus.Executed,
    pair: order.pair,
    type: order.type,
    amountSol: order.type === "buy" ? order.amount : undefined,
    amountToken: undefined,
    error: undefined,
    updatedAt: Date.now(),
  };
}

export const dbotxSimulateTrading: TradingApi = {
  async buy(
    pair: string,
    amountSol: number,
    _tokenName: string,
    _token: string,
  ): Promise<OrderResult> {
    return execute(submitBuy(pair, amountSol));
  },

  async sell(
    pair: string,
    percentage: number,
    _tokenName: string,
    _token: string,
  ): Promise<OrderResult> {
    return execute(submitSell(pair, percentage));
  },

  async getAccount(): Promise<TradingAccount> {
    await refreshSimulatorAccount();
    return getSimulatorAccount();
  },

  async shutdown(): Promise<void> {
    await resetSimulatorAccount();
  },
};
