/**
 * simulator/fast_buy_sell.ts
 *
 * Thin wrappers around the DBotX simulator's sim_swap_order
 * endpoint for buy and sell operations.
 *
 * simFastBuy(payload)  → creates a buy order, returns order ID
 * simFastSell(payload) → creates a sell order, returns order ID
 *
 * Both accept the same fields (type is set internally).
 * TP/SL groups can be passed at creation time; the server
 * generates individual PnL tasks per tier.
 */

import { CONFIG } from "../config";
import { fetchWithRetry } from "./http";

export type SimulatorTradeType = "buy" | "sell";

export interface ProfitLossGroup {
  pricePercent: number;
  amountPercent: number;
}

export interface SimulatorFastSwapRequest {
  chain?: "solana";
  pair: string;
  walletId?: string;
  type: SimulatorTradeType;
  amountOrPercent: number;
  stopEarnPercent?: number;
  stopLossPercent?: number;
  stopEarnGroup?: ProfitLossGroup[];
  stopLossGroup?: ProfitLossGroup[];
  priorityFee?: number | "";
  gasFeeDelta?: number;
  maxFeePerGas?: number;
  slippage?: number;
}

export interface SimulatorOrderResponse {
  err: boolean;
  res: { id: string };
  docs?: string;
}

const DEFAULT_GAS_FEE_DELTA = 5;
const DEFAULT_MAX_FEE_PER_GAS = 100;

const DEFAULT_SETTINGS = {
  chain: "solana" as const,
  walletId: "",
  priorityFee: "",
  gasFeeDelta: DEFAULT_GAS_FEE_DELTA,
  maxFeePerGas: DEFAULT_MAX_FEE_PER_GAS,
  slippage: 0.1,
};

async function createSimulatorOrder(
  request: SimulatorFastSwapRequest,
): Promise<string> {
  const response = await fetchWithRetry(
    `${CONFIG.baseUrl}/simulator/sim_swap_order`,
    {
      method: "POST",
      headers: {
        "x-api-key": CONFIG.dbotxApiKey!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...DEFAULT_SETTINGS,
        ...request,
      }),
    },
  );

  const json = (await response.json()) as SimulatorOrderResponse;

  if (json.err) {
    throw new Error("DBotX simulator rejected order");
  }

  return json.res.id;
}

export async function simFastBuy(
  request: Omit<SimulatorFastSwapRequest, "type">,
): Promise<string> {
  const orderId = await createSimulatorOrder({ ...request, type: "buy" });
  console.log(`[SIM BUY] ${request.pair} -> ${orderId}`);
  return orderId;
}

export async function simFastSell(
  request: Omit<SimulatorFastSwapRequest, "type">,
): Promise<string> {
  const orderId = await createSimulatorOrder({ ...request, type: "sell" });
  console.log(`[SIM SELL] ${request.pair} -> ${orderId}`);
  return orderId;
}
