import {
  submitBuy,
  submitSell,
  simulatorOrderSubmitted$,
  type SimulatorOrder,
} from "./simulator_orders";

import {
  getTask,
  waitForTaskConfirmed,
  simulatorTaskCompleted$,
  type SimulatorTask,
} from "./simulator_tasks";

import {
  simulatorAccount$,
  refreshSimulatorAccount,
  getSimulatorAccount,
  resetSimulatorAccount,
} from "./simulator_account";

import type {
  OrderResult,
  TradingAccount,
  TradingApi,
} from "../types";

/* -------------------------------------------------------------------------- */
/*                                   Events                                   */
/* -------------------------------------------------------------------------- */

export { simulatorOrderSubmitted$, simulatorTaskCompleted$, simulatorAccount$ };

/* -------------------------------------------------------------------------- */
/*                              Internal Helper                               */
/* -------------------------------------------------------------------------- */

async function execute(
  orderPromise: Promise<SimulatorOrder>,
): Promise<SimulatorTask> {
  const order = await orderPromise;

  const result = await waitForTaskConfirmed(order.id);

  await refreshSimulatorAccount();

  return result;
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

/* -------------------------------------------------------------------------- */
/*                              Legacy Exports                                */
/* -------------------------------------------------------------------------- */

export { getTask } from "./simulator_tasks";
export { waitForTaskConfirmed as waitForTask } from "./simulator_tasks";
