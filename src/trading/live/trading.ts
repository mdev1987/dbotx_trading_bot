import {
  submitBuy,
  submitSell,
  waitForTaskConfirmed,
  type LiveOrder,
} from "./orders";
import {
  fetchLiveBalance,
  toTradingAccount,
} from "./account";
import { getSolPriceUsd } from "../../data_stream/price_engine";
import { updateOrderMeta, addPosition as storeAddPosition } from "./store";
import type { OrderResult, TradingAccount, TradingApi } from "../types";

/* -------------------------------------------------------------------------- */
/*                              Internal Helper                               */
/* -------------------------------------------------------------------------- */

async function execute(
  orderPromise: Promise<LiveOrder>,
): Promise<OrderResult> {
  const order = await orderPromise;

  const task = await waitForTaskConfirmed(order.id).catch((err) => {
    console.warn(`[LiveTrading] Task polling failed for order ${order.id}:`, err);
    throw err;
  });

  return {
    id: task.id,
    status: task.status,
    pair: task.pair || order.pair,
    type: task.type,
    priceUsd: task.priceUsd,
    txHash: task.txHash,
    error: task.error,
    updatedAt: task.updatedAt,
  };
}

/* -------------------------------------------------------------------------- */
/*                             Trading Implementation                         */
/* -------------------------------------------------------------------------- */

export const liveTrading: TradingApi = {
  async buy(
    pair: string,
    amountSol: number,
    tokenName: string,
    token: string,
  ): Promise<OrderResult> {
    const result = await execute(submitBuy(pair, amountSol, tokenName, token));
    if (result.id && (tokenName || token)) {
      updateOrderMeta(result.id, { token, tokenName });
    }
    if (result.priceUsd && result.priceUsd > 0) {
      storeAddPosition({
        orderId: result.id,
        pair,
        token,
        tokenName,
        entryPriceUsd: result.priceUsd,
        sizeSol: amountSol,
        status: "open",
        openedAt: Date.now(),
      });
    }
    return result;
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
    const account = await fetchLiveBalance();
    const solPrice = getSolPriceUsd();
    return toTradingAccount(account, solPrice);
  },

  async shutdown(): Promise<void> {
    /* Live wallet balance can't be reset — just stop using the client. */
  },
};
