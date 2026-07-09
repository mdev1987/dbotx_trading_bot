import { CONFIG } from "../config";

/* -------------------------------------------------------------------------- */
/*                              Module Overview                               */
/* -------------------------------------------------------------------------- */

/**
 * DBotX Simulator API
 *
 * Responsibilities:
 *
 * - Create simulated buy orders
 * - Create simulated sell orders
 * - Read simulator wallet state
 * - Read simulated trades
 * - Read simulated TP/SL tasks
 *
 * This module does NOT:
 *
 * - Handle market prices
 * - Manage positions
 * - Execute real trades
 * - Listen to WebSocket events
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
    throw new Error("DBotX simulator API error");
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
    throw new Error("DBotX simulator API error");
  }

  return json.res;
}

/* -------------------------------------------------------------------------- */
/*                              Types                                         */
/* -------------------------------------------------------------------------- */

interface SimSwapRequest {
  chain: "solana";

  pair: string;

  type: "buy" | "sell";

  amountOrPercent: number;

  walletId: string;

  priorityFee: "";

  slippage: number;
}

export interface SimulatorOrderResponse {
  id: string;
}

export interface SimTradeRecord {
  id: string;

  priceUsd: number;

  totalUsd: number;
}

export interface SimulatorAccount {
  balance: number;

  change24h: number;

  changeAll: number;

  holdTokens: number;
}

export interface TradePair {
  _id: string;

  tokenInfo0: {
    contract: string;
    name: string;
    symbol: string;
  };

  tokenInfo1: {
    symbol: string;
  };

  costUsd: number;

  buyTokenAmount: string;

  sellTokenAmount: string;

  sellReceiveUsd: number;

  sellProfitPercent: number | null;

  fullProfitPercent: number;

  fullProfitUsd: number;
}

export interface PnLTask {
  sourceGroupIdx: number;

  state: string;

  triggerPriceUsd: number;

  basePriceUsd: number;

  currencyAmountUI: number;

  triggerPercent: number;

  triggerDirection: string;
}

/* -------------------------------------------------------------------------- */
/*                             Simulator BUY                                  */
/* -------------------------------------------------------------------------- */

/**
 * Opens a simulated buy position.
 */
export async function simBuy(pair: string, amountSol: number): Promise<string> {
  const payload: SimSwapRequest = {
    chain: "solana",

    pair,

    type: "buy",

    amountOrPercent: amountSol,

    walletId: "",

    priorityFee: "",

    slippage: CONFIG.defaultSlippage,
  };

  const result = await apiPost<SimulatorOrderResponse>(
    `${CONFIG.baseUrl}/simulator/sim_swap_order`,
    payload,
  );

  return result.id;
}

/* -------------------------------------------------------------------------- */
/*                             Simulator SELL                                 */
/* -------------------------------------------------------------------------- */

/**
 * Closes a simulated position.
 *
 * amountPercent:
 * 1 = sell 100%
 * 0.5 = sell 50%
 */
export async function simSell(
  pair: string,
  amountPercent = 1,
): Promise<string> {
  const payload: SimSwapRequest = {
    chain: "solana",

    pair,

    type: "sell",

    amountOrPercent: amountPercent,

    walletId: "",

    priorityFee: "",

    slippage: CONFIG.defaultSlippage,
  };

  const result = await apiPost<SimulatorOrderResponse>(
    `${CONFIG.baseUrl}/simulator/sim_swap_order`,
    payload,
  );

  return result.id;
}

/* -------------------------------------------------------------------------- */
/*                           Simulator Trades                                 */
/* -------------------------------------------------------------------------- */

export async function fetchSimTrade(
  orderId: string,
): Promise<SimTradeRecord | null> {
  try {
    const trades = await apiGet<SimTradeRecord[]>(
      `${CONFIG.baseUrl}/simulator/trades`,
    );

    return trades.find((trade) => trade.id === orderId) ?? null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*                          Simulator Pairs                                  */
/* -------------------------------------------------------------------------- */

export async function fetchTradePairs(balanceGt0 = true): Promise<TradePair[]> {
  const url = new URL(`${CONFIG.servapiBaseUrl}/simulator/trade_pairs`);

  url.searchParams.set("page", "0");

  url.searchParams.set("size", "20");

  url.searchParams.set("chain", "solana");

  url.searchParams.set("balanceGt0", String(balanceGt0));

  return apiGet<TradePair[]>(url.toString());
}

/* -------------------------------------------------------------------------- */
/*                         Simulator PNL Tasks                                */
/* -------------------------------------------------------------------------- */

export async function fetchPnLTasks(sourceId: string): Promise<PnLTask[]> {
  const url = new URL(
    `${CONFIG.servapiBaseUrl}/simulator/pnl_orders_from_swap_order`,
  );

  url.searchParams.set("sourceId", sourceId);

  url.searchParams.set("page", "0");

  url.searchParams.set("size", "20");

  url.searchParams.set("sort", "-1");

  return apiGet<PnLTask[]>(url.toString());
}

/* -------------------------------------------------------------------------- */
/*                          Simulator Account                                 */
/* -------------------------------------------------------------------------- */

/**
 * Returns simulator wallet status.
 */
export async function fetchSimAccount(): Promise<SimulatorAccount> {
  const account = await apiGet<{
    balance: string;
    change24h: number;
    changeAll: number;
    holdTokens: number;
  }>(`${CONFIG.baseUrl}/simulator/sim_account`);

  return {
    balance: Number(account.balance),

    change24h: account.change24h,

    changeAll: account.changeAll,

    holdTokens: account.holdTokens,
  };
}

/* -------------------------------------------------------------------------- */
/*                              Utilities                                     */
/* -------------------------------------------------------------------------- */

export async function waitSimulatorOrder(
  orderId: string,
  attempts = 20,
  delayMs = 2000,
): Promise<SimTradeRecord | null> {
  for (let i = 0; i < attempts; i++) {
    const trade = await fetchSimTrade(orderId);

    if (trade) {
      return trade;
    }

    await sleep(delayMs);
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
