import { Subject } from "rxjs";
import { CONFIG, type PartialTpTier } from "../../../config";
import { botHttp } from "../../http";
import { getSolPriceUsd } from "../../../data_stream/price_engine";
import { getLiveAccount, toTradingAccount } from "./account";
import { addOrder, updateOrderMeta, addPosition as storeAddPosition } from "./store";
import { buildStopEarnGroup, buildStopLossGroup, type StopEarnGroupItem, type TrailingStopGroupItem } from "../exit-config";
import type { OrderResult, TradingAccount, TradingApi } from "../../types";

export type LiveOrderSide = "buy" | "sell";

export type LiveOrderStatus = "init" | "processing" | "done" | "fail" | "expired";

export interface LiveOrder {
  id: string;
  type: LiveOrderSide;
  pair: string;
  amount: number;
  createdAt: number;
}

export interface LiveTask {
  id: string;
  status: LiveOrderStatus;
  type: "buy" | "sell";
  priceUsd?: number;
  txHash?: string;
  error?: string;
  updatedAt: number;
}

interface SubmitOrderResponse {
  err: boolean;
  res: { id: string };
}

interface SwapOrderInfo {
  id: string;
  state: LiveOrderStatus;
  chain: string;
  tradeType: "buy" | "sell";
  txPriceUsd?: number;
  swapHash?: string;
  errorCode?: string;
  errorMessage?: string;
}

interface SwapOrdersResponse {
  err: boolean;
  res: SwapOrderInfo[];
}

export const liveOrderSubmitted$ = new Subject<LiveOrder>();
export const liveTaskCompleted$ = new Subject<LiveTask>();

async function submitOrder(
  type: LiveOrderSide,
  pair: string,
  amount: number,
  tokenName?: string,
  token?: string,
): Promise<LiveOrder> {
  const hasPartialTp = CONFIG.partialTpEnabled && CONFIG.partialTpTiers.length > 0;
  const stopEarnGroup = hasPartialTp
    ? buildStopEarnGroup(CONFIG.partialTpTiers, CONFIG.backstopTpPct)
    : null;

  const stopLossPercent = CONFIG.stopLossPct !== 0 ? Math.abs(CONFIG.stopLossPct) : null;

  const hasStopLossTiers = CONFIG.stopLossTiers.length > 0;
  const stopLossGroup = hasStopLossTiers
    ? buildStopLossGroup(CONFIG.stopLossTiers)
    : null;

  const hasTrailing = CONFIG.trailingActivationPct > 0 && CONFIG.trailingDistancePct > 0;
  const trailingStopGroup = hasTrailing
    ? [{ pricePercent: CONFIG.trailingDistancePct, amountPercent: 1, activePricePercent: CONFIG.trailingActivationPct }] as TrailingStopGroupItem[]
    : null;

  const hasExitCustomConfig = CONFIG.pnlCustomConfigEnabled;
  const pnlCustomConfig = hasExitCustomConfig
    ? {
        customFeeAndTip: CONFIG.exitCustomFeeAndTip,
        priorityFee: CONFIG.exitPriorityFee,
        gasFeeDelta: CONFIG.defaultGasFeeDelta,
        maxFeePerGas: CONFIG.defaultMaxFeePerGas,
        jitoEnabled: CONFIG.exitJitoEnabled,
        jitoTip: CONFIG.exitJitoTip,
        maxSlippage: CONFIG.exitMaxSlippage,
        concurrentNodes: CONFIG.exitConcurrentNodes,
        retries: CONFIG.exitRetries,
      }
    : undefined;

  const response = await botHttp.post<SubmitOrderResponse>("/automation/swap_order", {
    chain: "solana",
    pair,
    walletId: CONFIG.walletId,
    type,
    amountOrPercent: amount,
    customFeeAndTip: CONFIG.customFeeAndTip,
    priorityFee: CONFIG.priorityFee,
    gasFeeDelta: CONFIG.defaultGasFeeDelta,
    maxFeePerGas: CONFIG.defaultMaxFeePerGas,
    jitoEnabled: CONFIG.jitoEnabled,
    jitoTip: CONFIG.jitoTip,
    maxSlippage: CONFIG.maxSlippage,
    concurrentNodes: CONFIG.concurrentNodes,
    retries: CONFIG.retries,
    migrateSellPercent: type === "buy" ? CONFIG.migrateSellPercent : undefined,
    minDevSellPercent: type === "buy" ? CONFIG.minDevSellPercent : undefined,
    devSellPercent: type === "buy" ? CONFIG.devSellPercent : undefined,
    stopEarnPercent: null,
    stopLossPercent: type === "buy" ? stopLossPercent : null,
    stopEarnGroup: type === "buy" ? stopEarnGroup : null,
    stopLossGroup: type === "buy" ? stopLossGroup : null,
    trailingStopGroup: type === "buy" ? trailingStopGroup : null,
    pnlOrderExpireDelta: CONFIG.pnlOrderExpireDeltaMs,
    pnlOrderExpireExecute: CONFIG.pnlOrderExpireExecute,
    pnlOrderExpireExecuteSellAll: CONFIG.pnlOrderExpireExecuteSellAll,
    pnlOrderUseMidPrice: CONFIG.pnlOrderUseMidPrice,
    pnlCustomConfigEnabled: hasExitCustomConfig ? true : undefined,
    pnlCustomConfig,
  });

  if (response.err) {
    throw new Error("Live trading rejected the order.");
  }

  const order: LiveOrder = {
    id: response.res.id,
    type,
    pair,
    amount,
    createdAt: Date.now(),
  };

  liveOrderSubmitted$.next(order);

  addOrder({
    id: order.id,
    type,
    pair,
    token: token ?? "",
    tokenName: tokenName ?? "",
    amountSol: type === "buy" ? amount : 0,
    createdAt: order.createdAt,
  });

  return order;
}

async function getTask(orderId: string): Promise<LiveTask> {
  const response = await botHttp.get<SwapOrdersResponse>(`/automation/swap_orders?ids=${orderId}`);

  if (response.err) {
    throw new Error("Live trading returned an error.");
  }

  const info = response.res[0];
  if (!info) {
    throw new Error("Live task not found.");
  }

  return {
    id: info.id,
    status: info.state,
    type: info.tradeType,
    priceUsd: info.txPriceUsd,
    txHash: info.swapHash,
    error: info.errorMessage || info.errorCode,
    updatedAt: Date.now(),
  };
}

export async function waitForTaskConfirmed(orderId: string): Promise<LiveTask> {
  const timeout = CONFIG.pnlTaskPollMs * CONFIG.maxLiveBuyPollAttempts;
  const started = Date.now();

  while (true) {
    const task = await getTask(orderId);

    if (task.status === "done") {
      liveTaskCompleted$.next(task);
      return task;
    }

    if (task.status === "fail" || task.status === "expired") {
      throw new Error(task.error ?? task.status);
    }

    if (Date.now() - started >= timeout) {
      throw new Error("Live task timed out.");
    }

    await sleep(CONFIG.pnlTaskPollMs);
  }
}

export async function submitBuy(
  pair: string,
  amountSol: number,
  tokenName?: string,
  token?: string,
): Promise<LiveOrder> {
  return submitOrder("buy", pair, amountSol, tokenName, token);
}

export async function submitSell(pair: string, percentage: number, tokenName?: string, token?: string): Promise<LiveOrder> {
  if (percentage <= 0 || percentage > 1) {
    throw new Error("Sell percentage must be between 0 and 1.");
  }
  return submitOrder("sell", pair, percentage, tokenName, token);
}

async function execute(orderPromise: Promise<LiveOrder>): Promise<OrderResult> {
  const order = await orderPromise;
  const task = await waitForTaskConfirmed(order.id).catch((err) => {
    console.warn(`[LiveTrading] Task polling failed for order ${order.id}:`, err);
    throw err;
  });
  return {
    id: task.id,
    status: task.status,
    pair: order.pair,
    type: task.type,
    priceUsd: task.priceUsd,
    txHash: task.txHash,
    error: task.error,
    updatedAt: task.updatedAt,
  };
}

export const dbotxLiveTrading: TradingApi = {
  async buy(pair: string, amountSol: number, tokenName: string, token: string): Promise<OrderResult> {
    const result = await execute(submitBuy(pair, amountSol, tokenName, token));
    if (result.id && (tokenName || token)) {
      updateOrderMeta(result.id, { token, tokenName });
    }
    storeAddPosition({
      orderId: result.id,
      pair,
      token,
      tokenName,
      entryPriceUsd: result.priceUsd ?? 0,
      sizeSol: amountSol,
      status: "open",
      openedAt: Date.now(),
    });
    return result;
  },

  async sell(pair: string, percentage: number, tokenName: string, token: string): Promise<OrderResult> {
    const result = await execute(submitSell(pair, percentage, tokenName, token));
    if (result.id && (tokenName || token)) {
      updateOrderMeta(result.id, { token, tokenName });
    }
    return result;
  },

  async getAccount(): Promise<TradingAccount> {
    const account = getLiveAccount();
    const solPrice = getSolPriceUsd();
    return toTradingAccount(account, solPrice);
  },

  async shutdown(): Promise<void> {
    console.log("[LiveTrading] Shutting down");
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
