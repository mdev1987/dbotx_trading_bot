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
): Promise<SimulatorTask> {
  const order = await orderPromise;

  let task: SimulatorTask | null = null;

  try {
    task = await waitForTaskConfirmed(order.id);
  } catch {
    /* Simulator doesn't expose a task status endpoint — assume immediate
       execution when the POST succeeds. */
  }

  await refreshSimulatorAccount();

  if (task) return task;

  return {
    id: order.id,
    status: SimulatorOrderStatus.Executed,
    pair: order.pair,
    type: order.type,
    updatedAt: Date.now(),
  };
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
