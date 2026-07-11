import { Subject } from "rxjs";
import { CONFIG, type PartialTpTier } from "../../config";
import { http } from "./simulator_http";

/* -------------------------------------------------------------------------- */
/*                                   Types                                    */
/* -------------------------------------------------------------------------- */

/**
 * Order side.
 */
export type SimulatorOrderSide = "buy" | "sell";

export enum SimulatorOrderStatus {
  Pending = "pending",
  Executed = "executed",
  Cancelled = "cancelled",
  Failed = "failed",
}

/**
 * Submitted simulator order.
 */
export interface SimulatorOrder {
  /** DBotX order ID */
  id: string;
  /** Buy or Sell */
  type: SimulatorOrderSide;
  /** Token / Pair address */
  pair: string;
  /** Amount of SOL (buy) or percentage (sell) */
  amount: number;
  /** Creation timestamp */
  createdAt: number;
}

interface SubmitOrderResponse {
  err: boolean;

  res: {
    id: string;
  };
}

/* -------------------------------------------------------------------------- */
/*                                  Events                                    */
/* -------------------------------------------------------------------------- */

/**
 * Emits whenever a simulator order is successfully submitted.
 *
 * Order submission only means the request has been accepted.
 * It DOES NOT mean the trade has been executed.
 */
export const simulatorOrderSubmitted$ = new Subject<SimulatorOrder>();

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
/*                              Internal Helper                               */
/* -------------------------------------------------------------------------- */

/**
 * Submit a simulator order.
 */
async function submitOrder(
  type: SimulatorOrderSide,
  pair: string,
  amount: number,
): Promise<SimulatorOrder> {
  const hasPartialTp = CONFIG.partialTpEnabled && CONFIG.partialTpTiers.length > 0;
  const stopEarnGroup = hasPartialTp
    ? buildStopEarnGroup(CONFIG.partialTpTiers, CONFIG.backstopTpPct)
    : null;

  const stopLossPercent =
    CONFIG.stopLossPct !== 0 ? Math.abs(CONFIG.stopLossPct) : null;

  const response = await http.post<SubmitOrderResponse>(
    "/simulator/sim_swap_order",
    {
      chain: "solana",

      walletId: "",

      pair,

      type,

      amountOrPercent: amount,

      priorityFee: "",

      gasFeeDelta: CONFIG.defaultGasFeeDelta,

      maxFeePerGas: CONFIG.defaultMaxFeePerGas,

      slippage: CONFIG.defaultSlippage,

      stopEarnPercent: null,

      stopLossPercent,

      stopEarnGroup,

      stopLossGroup: null,
    },
  );

  if (response.err) {
    throw new Error("Simulator rejected the order.");
  }

  const order: SimulatorOrder = {
    id: response.res.id,
    type,
    pair,
    amount,
    createdAt: Date.now(),
  };

  simulatorOrderSubmitted$.next(order);

  return order;
}

/* -------------------------------------------------------------------------- */
/*                                   Buy                                      */
/* -------------------------------------------------------------------------- */

/**
 * Submit a simulator BUY order.
 *
 * @param pair Token address.
 * @param amountSol Amount of SOL to spend.
 */
export async function submitBuy(
  pair: string,
  amountSol: number,
): Promise<SimulatorOrder> {
  return submitOrder("buy", pair, amountSol);
}

/* -------------------------------------------------------------------------- */
/*                                   Sell                                     */
/* -------------------------------------------------------------------------- */

/**
 * Submit a simulator SELL order.
 *
 * @param pair Token address.
 * @param percentage Sell percentage (0-1).
 */
export async function submitSell(
  pair: string,
  percentage: number,
): Promise<SimulatorOrder> {
  if (percentage <= 0 || percentage > 1) {
    throw new Error("Sell percentage must be between 0 and 1.");
  }

  return submitOrder("sell", pair, percentage);
}
