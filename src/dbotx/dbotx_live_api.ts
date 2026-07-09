import { CONFIG } from "../config";

import type { AveScannerSignal } from "../telegram/ave_scanner_parser";

/* -------------------------------------------------------------------------- */
/*                              Module Overview                               */
/* -------------------------------------------------------------------------- */

/**
 * DBotX LIVE Trading API
 *
 * Responsibilities:
 *
 * - Create live buy orders
 * - Create live sell orders
 * - Configure TP / SL / trailing stop
 * - Query swap order status
 *
 * This module communicates with DBotX REST API only.
 *
 * It does NOT:
 *
 * - Manage positions
 * - Listen to trade events
 * - Handle prices
 * - Decide when to buy/sell
 */

/* -------------------------------------------------------------------------- */
/*                              HTTP Helpers                                  */
/* -------------------------------------------------------------------------- */

const HEADERS = {
  "x-api-key": CONFIG.dbotxApiKey,
};

async function apiPost<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",

    headers: {
      ...HEADERS,
      "content-type": "application/json",
    },

    body: JSON.stringify(body),
  });

  const json = (await response.json()) as {
    err: boolean;
    res: T;
  };

  if (json.err) {
    throw new Error(`DBotX API error`);
  }

  return json.res;
}

async function apiGet<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: HEADERS,
  });

  const json = (await response.json()) as {
    err: boolean;
    res: T;
  };

  if (json.err) {
    throw new Error(`DBotX API error`);
  }

  return json.res;
}

/* -------------------------------------------------------------------------- */
/*                              Types                                         */
/* -------------------------------------------------------------------------- */

export interface LiveSwapOrderParams {
  chain: "solana";

  pair: string;

  walletId: string;

  type: "buy" | "sell";

  amountOrPercent: number;

  customFeeAndTip: boolean;

  priorityFee: string;

  gasFeeDelta: number;

  maxFeePerGas: number;

  jitoEnabled: boolean;

  jitoTip: number;

  maxSlippage: number;

  concurrentNodes: number;

  retries: number;

  stopEarnGroup?: Array<{
    pricePercent: number;
    amountPercent: number;
  }>;

  stopLossPercent?: number;

  trailingStopGroup?: Array<{
    pricePercent: number;
    amountPercent: number;
    activePricePercent: number;
  }>;

  pnlOrderExpireDelta: number;

  pnlOrderExpireExecute: boolean;

  pnlOrderUseMidPrice: boolean;

  pnlCustomConfigEnabled: boolean;

  pnlCustomConfig?: Record<string, unknown>;
}

export interface SwapOrderResponse {
  id: string;
}

/* -------------------------------------------------------------------------- */
/*                          Order Builder                                      */
/* -------------------------------------------------------------------------- */

function buildCommonParams() {
  return {
    customFeeAndTip: CONFIG.customFeeAndTip,

    priorityFee: CONFIG.priorityFee,

    gasFeeDelta: 5,

    maxFeePerGas: 100,

    jitoEnabled: CONFIG.jitoEnabled,

    jitoTip: CONFIG.jitoTip,

    maxSlippage: CONFIG.maxSlippage,

    concurrentNodes: CONFIG.concurrentNodes,

    retries: CONFIG.retries,
  };
}

function buildTakeProfitGroup():
  | Array<{
      pricePercent: number;
      amountPercent: number;
    }>
  | undefined {
  if (!CONFIG.backstopTpPct || CONFIG.backstopTpPct <= 0) {
    return undefined;
  }

  return [
    {
      pricePercent: CONFIG.backstopTpPct,

      amountPercent: 1,
    },
  ];
}

function buildTrailingStop() {
  if (CONFIG.trailingDistancePct <= 0) {
    return undefined;
  }

  return [
    {
      pricePercent: CONFIG.trailingDistancePct,

      amountPercent: 1,

      activePricePercent: CONFIG.trailingActivationPct,
    },
  ];
}

/* -------------------------------------------------------------------------- */
/*                              LIVE BUY                                      */
/* -------------------------------------------------------------------------- */

/**
 * Creates a live buy order.
 */
export async function liveBuy(
  pair: string,
  amountSol: number,
  signal?: AveScannerSignal,
): Promise<string> {
  const params: LiveSwapOrderParams = {
    chain: "solana",

    pair,

    walletId: CONFIG.walletId,

    type: "buy",

    amountOrPercent: amountSol,

    ...buildCommonParams(),

    stopEarnGroup: buildTakeProfitGroup(),

    stopLossPercent: CONFIG.stopLossPct,

    trailingStopGroup: buildTrailingStop(),

    pnlOrderExpireDelta: Math.min(
      CONFIG.pnlOrderExpireDeltaMs,
      CONFIG.baseTtlSecs * 1000,
    ),

    pnlOrderExpireExecute: CONFIG.pnlOrderExpireExecute,

    pnlOrderUseMidPrice: CONFIG.pnlOrderUseMidPrice,

    pnlCustomConfigEnabled: true,

    pnlCustomConfig: buildCommonParams(),
  };

  const result = await apiPost<SwapOrderResponse>(
    `${CONFIG.baseUrl}/automation/swap_order`,
    params,
  );

  return result.id;
}

/* -------------------------------------------------------------------------- */
/*                              LIVE SELL                                     */
/* -------------------------------------------------------------------------- */

/**
 * Creates a live sell order.
 *
 * amountOrPercent = 1 means sell 100%.
 */
export async function liveSell(
  pair: string,
  amountPercent = 1,
): Promise<string> {
  const params: LiveSwapOrderParams = {
    chain: "solana",

    pair,

    walletId: CONFIG.walletId,

    type: "sell",

    amountOrPercent: amountPercent,

    ...buildCommonParams(),

    pnlOrderExpireDelta: 60_000,

    pnlOrderExpireExecute: true,

    pnlOrderUseMidPrice: false,

    pnlCustomConfigEnabled: false,
  };

  const result = await apiPost<SwapOrderResponse>(
    `${CONFIG.baseUrl}/automation/swap_order`,
    params,
  );

  return result.id;
}

/* -------------------------------------------------------------------------- */
/*                          ORDER QUERY                                       */
/* -------------------------------------------------------------------------- */

export interface SwapOrderStatus {
  id: string;

  state: "created" | "processing" | "done" | "fail" | "expired" | string;

  txPriceUsd?: number;

  txHash?: string;
}

export async function querySwapOrder(
  orderId: string,
): Promise<SwapOrderStatus | null> {
  try {
    const result = await apiGet<SwapOrderStatus[]>(
      `${CONFIG.baseUrl}/automation/swap_orders?ids=${encodeURIComponent(orderId)}`,
    );

    return result[0] ?? null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*                        WAIT FOR COMPLETION                                 */
/* -------------------------------------------------------------------------- */

export async function waitForSwapOrder(
  orderId: string,
  maxAttempts = 30,
  intervalMs = 2000,
): Promise<SwapOrderStatus> {
  for (let i = 0; i < maxAttempts; i++) {
    const order = await querySwapOrder(orderId);

    if (!order) {
      await delay(intervalMs);

      continue;
    }

    if (order.state === "done") {
      return order;
    }

    if (order.state === "fail" || order.state === "expired") {
      throw new Error(`DBotX order ${orderId}: ${order.state}`);
    }

    await delay(intervalMs);
  }

  throw new Error(`DBotX order timeout: ${orderId}`);
}

/* -------------------------------------------------------------------------- */
/*                              Helpers                                       */
/* -------------------------------------------------------------------------- */

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
