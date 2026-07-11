// main.ts

import { CONFIG } from "./config";

import { simulatorTrading } from "./trading/simulator/simulator";

import type {
  OrderResult,
  TradingAccount,
  TradingApi,
} from "./trading/types";

/* -------------------------------------------------------------------------- */
/*                              Trading Backend                               */
/* -------------------------------------------------------------------------- */

/**
 * Current trading backend.
 *
 * For now only the simulator is available.
 *
 * When the live module is implemented this file will become:
 *
 * const trading =
 *   CONFIG.liveMode
 *     ? liveTrading
 *     : simulatorTrading;
 */
export const trading: TradingApi = simulatorTrading;

/* -------------------------------------------------------------------------- */
/*                            Convenience Functions                           */
/* -------------------------------------------------------------------------- */

/**
 * Submit a buy order.
 */
export async function buy(
  pair: string,
  amountSol: number,
  tokenName: string,
  token: string,
): Promise<OrderResult> {
  return trading.buy(pair, amountSol, tokenName, token);
}

/**
 * Submit a sell order.
 */
export async function sell(
  pair: string,
  percentage: number,
  tokenName: string,
  token: string,
): Promise<OrderResult> {
  return trading.sell(pair, percentage, tokenName, token);
}

/**
 * Retrieve simulator account information.
 */
export async function getAccount(): Promise<TradingAccount> {
  return trading.getAccount();
}

/**
 * Shutdown the trading backend.
 */
export async function shutdown(): Promise<void> {
  await trading.shutdown();
}

/* -------------------------------------------------------------------------- */
/*                                 Trading Mode                               */
/* -------------------------------------------------------------------------- */

/**
 * Current trading mode.
 */
export const tradingMode = CONFIG.liveMode ? "live" : "simulate";

/**
 * Returns true when running with real funds.
 *
 * Currently always false until the live backend is implemented.
 */
export const isLiveTrading = false;

/**
 * Returns true when using the simulator.
 */
export const isSimulatorTrading = true;
