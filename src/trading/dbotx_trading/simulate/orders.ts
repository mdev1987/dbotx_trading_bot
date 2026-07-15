import { Subject } from "rxjs";
import { CONFIG } from "../../../config";
import { simHttp as http } from "../../http";
import { buildStopEarnGroup } from "../exit-config";

export type SimulatorOrderSide = "buy" | "sell";

export enum SimulatorOrderStatus {
  Pending = "pending",
  Executed = "executed",
  Cancelled = "cancelled",
  Failed = "failed",
}

export interface SimulatorOrder {
  id: string;
  type: SimulatorOrderSide;
  pair: string;
  amount: number;
  createdAt: number;
}

interface SubmitOrderResponse {
  err: boolean;
  res: {
    id: string;
  };
}

export const simulatorOrderSubmitted$ = new Subject<SimulatorOrder>();

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

export async function submitBuy(
  pair: string,
  amountSol: number,
): Promise<SimulatorOrder> {
  return submitOrder("buy", pair, amountSol);
}

export async function submitSell(
  pair: string,
  percentage: number,
): Promise<SimulatorOrder> {
  if (percentage <= 0 || percentage > 1) {
    throw new Error("Sell percentage must be between 0 and 1.");
  }

  return submitOrder("sell", pair, percentage);
}
