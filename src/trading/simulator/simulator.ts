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
  type SimulatorAccount,
} from "./simulator_account";

export interface TradingApi {
  /**
   * Buy a token.
   *
   * Resolves once the trade has completed.
   */
  buy(
    pair: string,
    amountSol: number,
    tokenName: string,
    token: string,
  ): Promise<SimulatorOrder>;

  /**
   * Sell part or all of a position.
   *
   * percentage:
   *   1.0 = 100%
   *   0.5 = 50%
   */
  sell(
    pair: string,
    percentage: number,
    tokenName: string,
    token: string,
  ): Promise<SimulatorOrder>;
  /**
   * Refresh and return the latest account state.
   */
  getAccount(): Promise<SimulatorAccount>;

  /**
   * Shutdown the backend.
   */
  shutdown(): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/*                                   Events                                   */
/* -------------------------------------------------------------------------- */

export { simulatorOrderSubmitted$, simulatorTaskCompleted$, simulatorAccount$ };

/* -------------------------------------------------------------------------- */
/*                              Internal Helper                               */
/* -------------------------------------------------------------------------- */

/**
 * Executes a simulator order.
 *
 * Flow:
 *
 * Submit
 *   ↓
 * Wait
 *   ↓
 * Refresh Account
 *   ↓
 * Return OrderResult
 */
async function execute(
  orderPromise: Promise<SimulatorOrder>,
): Promise<SimulatorTask> {
  const order = await orderPromise;

  const result = await waitForTaskConfirmed(order.id);

  await refreshSimulatorAccount();

  return result;
}

/* -------------------------------------------------------------------------- */
/*                                   Trading                                  */
/* -------------------------------------------------------------------------- */

export function buy(
  pair: string,
  amountSol: number,
  tokenName: string,
  token: string,
): Promise<SimulatorTask> {
  return execute(submitBuy(pair, amountSol));
}

export function sell(
  pair: string,
  percentage: number,
  tokenName: string,
  token: string,
): Promise<SimulatorTask> {
  return execute(submitSell(pair, percentage));
}

/* -------------------------------------------------------------------------- */
/*                                  Account                                   */
/* -------------------------------------------------------------------------- */

export async function getAccount(): Promise<SimulatorAccount> {
  await refreshSimulatorAccount();

  return getSimulatorAccount();
}

/* -------------------------------------------------------------------------- */
/*                                   Tasks                                    */
/* -------------------------------------------------------------------------- */

export { getTask };
export { waitForTaskConfirmed as waitForTask };

/* -------------------------------------------------------------------------- */
/*                                 Lifecycle                                  */
/* -------------------------------------------------------------------------- */

export async function shutdown(): Promise<void> {
  await resetSimulatorAccount();
}
