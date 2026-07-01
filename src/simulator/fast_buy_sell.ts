// src/simulator/fast_buy_sell.ts

import { CONFIG } from "../config";

/* ============================================================
 * Types
 * ============================================================
 */

export type SimulatorTradeType = "buy" | "sell";

export interface ProfitLossGroup {
  /**
   * Trigger percentage.
   *
   * Example:
   * 0.2 = 20%
   * 1.0 = 100%
   */
  pricePercent: number;

  /**
   * Amount to sell.
   *
   * 0.5 = 50%
   * 1.0 = 100%
   */
  amountPercent: number;
}

export interface SimulatorFastSwapRequest {
  /**
   * Blockchain.
   */
  chain?: "solana";

  /**
   * Pair address.
   */
  pair: string;

  /**
   * Empty string means simulator wallet.
   */
  walletId?: string;

  /**
   * buy or sell
   */
  type: SimulatorTradeType;

  /**
   * BUY:
   * Amount in SOL.
   *
   * SELL:
   * Percentage of holdings.
   */
  amountOrPercent: number;

  /* --------------------------------------------------------
   * Simple TP/SL
   * -------------------------------------------------------- */

  /**
   * Sell all after profit target.
   *
   * Example:
   * 0.5 = +50%
   */
  stopEarnPercent?: number;

  /**
   * Sell all after loss target.
   *
   * Example:
   * 0.5 = -50%
   */
  stopLossPercent?: number;

  /* --------------------------------------------------------
   * Partial TP/SL
   * -------------------------------------------------------- */

  /**
   * Partial take profit ladder.
   *
   * Overrides stopEarnPercent.
   */
  stopEarnGroup?: ProfitLossGroup[];

  /**
   * Partial stop loss ladder.
   *
   * Overrides stopLossPercent.
   */
  stopLossGroup?: ProfitLossGroup[];

  /* --------------------------------------------------------
   * Execution settings
   * -------------------------------------------------------- */

  /**
   * Solana priority fee.
   *
   * Empty string = automatic.
   */
  priorityFee?: number | "";

  /**
   * EVM only.
   */
  gasFeeDelta?: number;

  /**
   * EVM only.
   */
  maxFeePerGas?: number;

  /**
   * Maximum slippage.
   *
   * 0.1 = 10%
   */
  slippage?: number;
}

export interface SimulatorOrderResponse {
  err: boolean;

  res: {
    id: string;
  };

  docs?: string;
}

/* ============================================================
 * Default settings
 * ============================================================
 */

const DEFAULT_SETTINGS = {
  chain: "solana" as const,
  walletId: "",
  priorityFee: "",
  gasFeeDelta: 5,
  maxFeePerGas: 100,
  slippage: 0.1,
};

/* ============================================================
 * Internal request helper
 * ============================================================
 */

async function createSimulatorOrder(
  request: SimulatorFastSwapRequest,
): Promise<string> {
  const response = await fetch(
    "https://api-bot-v1.dbotx.com/simulator/sim_swap_order",
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

  if (!response.ok) {
    throw new Error(`DBotX HTTP ${response.status}: ${response.statusText}`);
  }

  const json = (await response.json()) as SimulatorOrderResponse;

  if (json.err) {
    throw new Error(`DBotX simulator rejected order`);
  }

  return json.res.id;
}

/* ============================================================
 * Public API
 * ============================================================
 */

/**
 * Simulated BUY.
 */
export async function simFastBuy(
  request: Omit<SimulatorFastSwapRequest, "type">,
): Promise<string> {
  const orderId = await createSimulatorOrder({
    ...request,
    type: "buy",
  });

  console.log(`[SIM BUY] ${request.pair} -> ${orderId}`);

  return orderId;
}

/**
 * Simulated SELL.
 */
export async function simFastSell(
  request: Omit<SimulatorFastSwapRequest, "type">,
): Promise<string> {
  const orderId = await createSimulatorOrder({
    ...request,
    type: "sell",
  });

  console.log(`[SIM SELL] ${request.pair} -> ${orderId}`);

  return orderId;
}
