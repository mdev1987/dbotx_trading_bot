import {
  submitBuy,
  submitSell,
  type SimulatorOrder,
} from "./orders";

import {
  waitForTaskConfirmed,
  type SimulatorTask,
} from "./tasks";

import {
  refreshSimulatorAccount,
  getSimulatorAccount,
  resetSimulatorAccount,
} from "./account";

import type {
  OrderResult,
  TradingAccount,
  TradingApi,
} from "../types";

/* -------------------------------------------------------------------------- */
/*                              Internal Helper                               */
/* -------------------------------------------------------------------------- */

async function execute(
  orderPromise: Promise<SimulatorOrder>,
): Promise<SimulatorTask> {
  const order = await orderPromise;

  const task = await waitForTaskConfirmed(order.id, order.pair).catch((err) => {
    console.warn(`[SimTrading] Task polling failed for order ${order.id}:`, err);
    throw err;
  });

  await refreshSimulatorAccount();

  return task;
}

/* -------------------------------------------------------------------------- */
/*                             Trading Implementation                         */
/* -------------------------------------------------------------------------- */

export const simulatorTrading: TradingApi = {
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
