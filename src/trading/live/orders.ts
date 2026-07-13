import { Subject } from "rxjs";
import { CONFIG, type PartialTpTier } from "../../config";
import { botHttp } from "../http";
import { addOrder } from "./store";

/* -------------------------------------------------------------------------- */
/*                                   Types                                    */
/* -------------------------------------------------------------------------- */

export type LiveOrderSide = "buy" | "sell";

export enum LiveOrderStatus {
  Init = "init",
  Processing = "processing",
  Executed = "done",
  Failed = "fail",
  Expired = "expired",
}

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
  pair: string;
  type: "buy" | "sell";
  priceUsd?: number;
  txHash?: string;
  error?: string;
  updatedAt: number;
}

/* -------------------------------------------------------------------------- */
/*                              API Response Types                            */
/* -------------------------------------------------------------------------- */

interface SubmitOrderResponse {
  err: boolean;
  res: { id: string };
}

interface SwapOrderInfo {
  id: string;
  state: "init" | "processing" | "done" | "fail" | "expired";
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

/* -------------------------------------------------------------------------- */
/*                                  Events                                    */
/* -------------------------------------------------------------------------- */

export const liveOrderSubmitted$ = new Subject<LiveOrder>();
export const liveTaskCompleted$ = new Subject<LiveTask>();

/* -------------------------------------------------------------------------- */
/*                              TP / SL Helpers                               */
/* -------------------------------------------------------------------------- */

interface StopEarnGroupItem {
  pricePercent: number;
  amountPercent: number;
}

function buildStopEarnGroup(
  tiers: PartialTpTier[],
  backstopPct: number,
): StopEarnGroupItem[] {
  const group = tiers.map((tier) => ({
    pricePercent: tier.at,
    amountPercent: tier.pct,
  }));

  if (backstopPct > 0) {
    const totalPct = tiers.reduce((sum, t) => sum + t.pct, 0);
    const remaining = +(1 - totalPct).toFixed(4);
    if (remaining > 0) {
      group.push({
        pricePercent: backstopPct,
        amountPercent: remaining,
      });
    }
  }

  return group;
}

/* -------------------------------------------------------------------------- */
/*                              Submit Order                                  */
/* -------------------------------------------------------------------------- */

async function submitOrder(
  type: LiveOrderSide,
  pair: string,
  amount: number,
): Promise<LiveOrder> {
  const hasPartialTp = CONFIG.partialTpEnabled && CONFIG.partialTpTiers.length > 0;
  const stopEarnGroup = hasPartialTp
    ? buildStopEarnGroup(CONFIG.partialTpTiers, CONFIG.backstopTpPct)
    : null;

  const stopLossPercent =
    CONFIG.stopLossPct !== 0 ? Math.abs(CONFIG.stopLossPct) : null;

  const hasStopLossTiers = CONFIG.stopLossTiers.length > 0;
  const stopLossGroup = hasStopLossTiers
    ? CONFIG.stopLossTiers.map((tier) => ({
        pricePercent: Math.abs(tier.at),
        amountPercent: tier.pct,
      }))
    : null;

  const hasTrailing = CONFIG.trailingActivationPct > 0 && CONFIG.trailingDistancePct > 0;
  const trailingStopGroup = hasTrailing
    ? [{ pricePercent: CONFIG.trailingDistancePct, amountPercent: 1, activePricePercent: CONFIG.trailingActivationPct }]
    : null;

  const hasExitCustomConfig = CONFIG.pnlCustomConfigEnabled;
  const pnlCustomConfig = hasExitCustomConfig
    ? {
        customFeeAndTip: CONFIG.exitCustomFeeAndTip,
        priorityFee: CONFIG.exitPriorityFee,
        gasFeeDelta: 5,
        maxFeePerGas: 100,
        jitoEnabled: CONFIG.exitJitoEnabled,
        jitoTip: CONFIG.exitJitoTip,
        maxSlippage: CONFIG.exitMaxSlippage,
        concurrentNodes: CONFIG.exitConcurrentNodes,
        retries: CONFIG.exitRetries,
      }
    : undefined;

  const response = await botHttp.post<SubmitOrderResponse>(
    "/automation/swap_order",
    {
      chain: "solana",
      pair,
      walletId: CONFIG.walletId,
      type,
      amountOrPercent: amount,
      customFeeAndTip: CONFIG.customFeeAndTip,
      priorityFee: CONFIG.priorityFee,
      gasFeeDelta: 5,
      maxFeePerGas: 100,
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
    },
  );

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

  // Persist order for recovery
  addOrder({
    id: order.id,
    type,
    pair,
    token: "",
    tokenName: "",
    amountSol: type === "buy" ? amount : 0,
    createdAt: order.createdAt,
  });

  return order;
}

/* -------------------------------------------------------------------------- */
/*                              Get Task Status                               */
/* -------------------------------------------------------------------------- */

async function getTask(orderId: string): Promise<LiveTask> {
  const response = await botHttp.get<SwapOrdersResponse>(
    `/automation/swap_orders?ids=${orderId}`,
  );

  if (response.err) {
    throw new Error("Live trading returned an error.");
  }

  const info = response.res[0];
  if (!info) {
    throw new Error("Live task not found.");
  }

  return {
    id: info.id,
    status: info.state as LiveOrderStatus,
    pair: "",
    type: info.tradeType,
    priceUsd: info.txPriceUsd,
    txHash: info.swapHash,
    error: info.errorMessage || info.errorCode,
    updatedAt: Date.now(),
  };
}

/* -------------------------------------------------------------------------- */
/*                              Wait For Task                                 */
/* -------------------------------------------------------------------------- */

export async function waitForTaskConfirmed(orderId: string): Promise<LiveTask> {
  const timeout = CONFIG.pnlTaskPollMs * CONFIG.maxSwapOrderPollAttempts;
  const started = Date.now();

  while (true) {
    const task = await getTask(orderId);

    switch (task.status) {
      case LiveOrderStatus.Executed:
        liveTaskCompleted$.next(task);
        return task;

      case LiveOrderStatus.Failed:
      case LiveOrderStatus.Expired:
        throw new Error(task.error ?? task.status);
    }

    if (Date.now() - started >= timeout) {
      throw new Error("Live task timed out.");
    }

    await sleep(CONFIG.pnlTaskPollMs);
  }
}

/* -------------------------------------------------------------------------- */
/*                                   Buy                                      */
/* -------------------------------------------------------------------------- */

export async function submitBuy(
  pair: string,
  amountSol: number,
  tokenName?: string,
  token?: string,
): Promise<LiveOrder> {
  return submitOrder("buy", pair, amountSol);
}

/* -------------------------------------------------------------------------- */
/*                                   Sell                                     */
/* -------------------------------------------------------------------------- */

export async function submitSell(
  pair: string,
  percentage: number,
): Promise<LiveOrder> {
  if (percentage <= 0 || percentage > 1) {
    throw new Error("Sell percentage must be between 0 and 1.");
  }

  return submitOrder("sell", pair, percentage);
}

/* -------------------------------------------------------------------------- */
/*                                   Helper                                   */
/* -------------------------------------------------------------------------- */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
