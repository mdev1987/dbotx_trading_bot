import {
  submitBuy,
  submitSell,
  SimulatorOrderStatus,
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
  poll: boolean = true,
): Promise<SimulatorTask> {
  const order = await orderPromise;

  if (!poll) {
    console.log(`[SimTrading] Submitted ${order.type} ${order.id}, skipping task poll.`);
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
    return execute(submitSell(pair, percentage), false);
  },

  async getAccount(): Promise<TradingAccount> {
    await refreshSimulatorAccount();
    return getSimulatorAccount();
  },

  async shutdown(): Promise<void> {
    await resetSimulatorAccount();
  },
};
