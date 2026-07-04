/**
 * -----------------------------------------------------------------------------
 * DBotX Simulator Fast Buy / Sell API
 * -----------------------------------------------------------------------------
 *
 * Thin wrapper around the DBotX Simulator Swap endpoint.
 *
 * Responsibilities:
 *   • Build simulator order payloads
 *   • Apply default request settings
 *   • Execute authenticated HTTP requests
 *   • Validate simulator responses
 *   • Return the created simulator order ID
 *
 * This module intentionally contains no trading logic.
 * Position sizing, TP/SL calculation, and portfolio management belong to
 * higher-level services.
 * -----------------------------------------------------------------------------
 */

import { CONFIG } from "../config";
import { fetchWithRetry } from "./http";

/* -------------------------------------------------------------------------- */
/*                                   Types                                    */
/* -------------------------------------------------------------------------- */

/**
 * Supported simulator trade directions.
 */
export type SimulatorTradeType = "buy" | "sell";

/**
 * One take-profit / stop-loss level.
 */
export interface ProfitLossGroup {
  /** Price change percentage (0.50 = 50%) */
  pricePercent: number;

  /** Position percentage to sell (0–1) */
  amountPercent: number;
}

/**
 * Simulator swap request.
 */
export interface SimulatorFastSwapRequest {
  chain?: "solana";

  pair: string;

  walletId?: string;

  type: SimulatorTradeType;

  /**
   * Buy:
   *   SOL amount
   *
   * Sell:
   *   percentage (0-1)
   */
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

/**
 * DBotX simulator response.
 */
interface SimulatorOrderResponse {
  err: boolean;

  res: {
    id: string;
  };

  docs?: string;
}

/* -------------------------------------------------------------------------- */
/*                               Default Values                               */
/* -------------------------------------------------------------------------- */

const SIMULATOR_ENDPOINT = "/simulator/sim_swap_order";

/**
 * Default request values.
 *
 * These may be overridden by the caller.
 */
const DEFAULT_REQUEST: Readonly<
  Required<
    Pick<
      SimulatorFastSwapRequest,
      | "chain"
      | "walletId"
      | "priorityFee"
      | "gasFeeDelta"
      | "maxFeePerGas"
      | "slippage"
    >
  >
> = {
  chain: "solana" as const,
  walletId: "",

  priorityFee: "" as const,

  gasFeeDelta: CONFIG.defaultGasFeeDelta,

  maxFeePerGas: CONFIG.defaultMaxFeePerGas,

  slippage: CONFIG.defaultSlippage,
};

/* -------------------------------------------------------------------------- */
/*                              Internal Helpers                              */
/* -------------------------------------------------------------------------- */

/**
 * Build the request payload sent to DBotX.
 *
 * Merges the caller's request over the default settings so any omitted
 * fields receive sensible defaults (chain, walletId, fees, slippage, etc.).
 *
 * @param request - Partial or full swap parameters from the caller
 * @returns A fully populated request object guaranteed to have every required field
 */
function buildPayload(
  request: SimulatorFastSwapRequest,
): SimulatorFastSwapRequest {
  return {
    ...DEFAULT_REQUEST,
    ...request,
  };
}

/**
 * Execute a simulator order.
 *
 * @param request Simulator order request.
 * @returns Simulator order ID.
 *
 * @throws Error
 * If the HTTP request fails or DBotX rejects the order.
 */
async function createSimulatorOrder(
  request: SimulatorFastSwapRequest,
): Promise<string> {
  // POST the order payload to the simulator swap endpoint with auth headers
  const response = await fetchWithRetry(
    `${CONFIG.baseUrl}${SIMULATOR_ENDPOINT}`,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        "x-api-key": CONFIG.dbotxApiKey!,
      },

      // Serialize the merged (defaults + caller) request body to JSON
      body: JSON.stringify(buildPayload(request)),
    },
  );

  // Parse the JSON response body
  const json = (await response.json()) as SimulatorOrderResponse;

  // Reject if the API returned an error flag
  if (json.err) {
    throw new Error(
      `Simulator rejected ${request.type} order for ${request.pair}`,
    );
  }

  // Validate that the response contains an order ID
  if (!json.res?.id) {
    throw new Error("Simulator returned an invalid response.");
  }

  // Return the simulator order ID on success
  return json.res.id;
}

/* -------------------------------------------------------------------------- */
/*                               Public Helpers                               */
/* -------------------------------------------------------------------------- */

/**
 * Submit a simulator BUY order.
 *
 * @param request Buy request (type is automatically set to "buy").
 * @returns Simulator order ID.
 *
 * @throws Error if the HTTP request fails or the simulator rejects the order.
 */
export async function simFastBuy(
  request: Omit<SimulatorFastSwapRequest, "type">,
): Promise<string> {
  const orderId = await createSimulatorOrder({
    ...request,
    type: "buy",
  });

  console.info(`[sim] BUY ${request.pair} -> ${orderId}`);

  return orderId;
}

/**
 * Submit a simulator SELL order.
 *
 * @param request Sell request (type is automatically set to "sell").
 * @returns Simulator order ID.
 *
 * @throws Error if the HTTP request fails or the simulator rejects the order.
 */
export async function simFastSell(
  request: Omit<SimulatorFastSwapRequest, "type">,
): Promise<string> {
  const orderId = await createSimulatorOrder({
    ...request,
    type: "sell",
  });

  console.info(`[sim] SELL ${request.pair} -> ${orderId}`);

  return orderId;
}
