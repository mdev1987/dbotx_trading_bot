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

export type SimulatorTradeType = "buy" | "sell";

export interface ProfitLossGroup {
  /** Trigger price as a decimal (0.2 = 20%). */
  pricePercent: number;
  /** Position fraction to sell (0.5 = 50%). */
  amountPercent: number;
}

export interface SimulatorFastSwapRequest {
  chain?: "solana";
  pair: string;
  walletId?: string;
  type: SimulatorTradeType;
  /** BUY: SOL amount.  SELL: fraction of holdings (1 = all). */
  amountOrPercent: number;
  /** Sell all after profit target (overridden by stopEarnGroup). */
  stopEarnPercent?: number;
  /** Sell all after loss target (overridden by stopLossGroup). */
  stopLossPercent?: number;
  /** Partial take-profit ladder. */
  stopEarnGroup?: ProfitLossGroup[];
  /** Partial stop-loss ladder. */
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

const DEFAULT_SETTINGS = {
  chain: "solana" as const,
  walletId: "",
  priorityFee: "",
  gasFeeDelta: 5,
  maxFeePerGas: 100,
  slippage: 0.1,
};

/** Request timeout in milliseconds. */
const FETCH_TIMEOUT_MS = 30_000;

async function createSimulatorOrder(
  request: SimulatorFastSwapRequest,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(
      "https://api-bot-v1.dbotx.com/simulator/sim_swap_order",
      {
        signal: controller.signal,
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

    if (!response.ok) {
      throw new Error(`DBotX HTTP ${response.status}: ${response.statusText}`);
    }

    const json = (await response.json()) as SimulatorOrderResponse;

    if (json.err) {
      throw new Error("DBotX simulator rejected order");
    }

    return json.res.id;
  } finally {
    clearTimeout(timer);
  }
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
