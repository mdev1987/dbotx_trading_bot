import { CONFIG } from "../config";

import type { AveScannerSignal } from "../telegram/ave_scanner_parser";

/* -------------------------------------------------------------------------- */
/*                              HTTP Helpers                                  */
/* -------------------------------------------------------------------------- */

const HEADERS = {
  "x-api-key": CONFIG.dbotxApiKey,
};

function buildUrl(
  base: string,
  path: string,
  params?: Record<string, string | number>,
): string {
  const url = new URL(`${base}${path}`);

  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
  }

  return url.toString();
}

async function apiGet<T>(
  base: string,
  path: string,
  params?: Record<string, string | number>,
): Promise<T> {
  const response = await fetch(buildUrl(base, path, params), {
    headers: HEADERS,
  });

  const json = (await response.json()) as {
    err: boolean;
    res: T;
  };

  if (json.err) {
    throw new Error(`DBotX GET failed: ${path}`);
  }

  return json.res;
}

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
    throw new Error(`DBotX POST failed`);
  }

  return json.res;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* -------------------------------------------------------------------------- */
/*                             Simulator API                                  */
/* -------------------------------------------------------------------------- */

interface SimSwapRequest {
  chain: string;

  pair: string;

  type: "buy" | "sell";

  amountOrPercent: number;

  walletId?: string;

  priorityFee?: number | "";

  slippage?: number;
}

export async function simBuy(pair: string, amountSol: number): Promise<string> {
  const body: SimSwapRequest = {
    chain: "solana",

    pair,

    type: "buy",

    amountOrPercent: amountSol,

    walletId: "",

    priorityFee: "",

    slippage: CONFIG.defaultSlippage,
  };

  const result = await apiPost<{ id: string }>(
    `${CONFIG.baseUrl}/simulator/sim_swap_order`,
    body,
  );

  return result.id;
}

export async function simSell(
  pair: string,
  amountPercent = 1,
): Promise<string> {
  const body: SimSwapRequest = {
    chain: "solana",

    pair,

    type: "sell",

    amountOrPercent: amountPercent,

    walletId: "",

    priorityFee: "",

    slippage: CONFIG.defaultSlippage,
  };

  const result = await apiPost<{ id: string }>(
    `${CONFIG.baseUrl}/simulator/sim_swap_order`,
    body,
  );

  return result.id;
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

  fullProfitPercent: number;

  fullProfitUsd: number;
}

export async function fetchTradePairs(balanceGt0 = true): Promise<TradePair[]> {
  return apiGet<TradePair[]>(CONFIG.servapiBaseUrl, "/simulator/trade_pairs", {
    page: 0,
    size: 20,
    chain: "solana",
    balanceGt0: String(balanceGt0),
  });
}

export interface SimTradeRecord {
  id: string;

  priceUsd: number;

  totalUsd: number;
}

export async function fetchSimTrade(
  orderId: string,
): Promise<SimTradeRecord | null> {
  try {
    const trades = await apiGet<SimTradeRecord[]>(
      CONFIG.baseUrl,
      "/simulator/trades",
    );

    return trades.find((t) => t.id === orderId) ?? null;
  } catch {
    return null;
  }
}

export interface PnLTask {
  state: string;

  triggerPriceUsd: number;

  triggerPercent: number;

  triggerDirection: string;
}

export async function fetchPnLTasks(sourceId: string): Promise<PnLTask[]> {
  return apiGet<PnLTask[]>(
    CONFIG.servapiBaseUrl,
    "/simulator/pnl_orders_from_swap_order",
    {
      sourceId,
      page: 0,
      size: 20,
      sort: "-1",
    },
  );
}

export interface SimulatorAccount {
  balance: number;

  change24h: number;

  changeAll: number;

  holdTokens: number;
}

export async function fetchSimAccount(): Promise<SimulatorAccount> {
  const result = await apiGet<{
    balance: string;
    change24h: number;
    changeAll: number;
    holdTokens: number;
  }>(CONFIG.baseUrl, "/simulator/sim_account");

  return {
    balance: Number(result.balance),

    change24h: result.change24h,

    changeAll: result.changeAll,

    holdTokens: result.holdTokens,
  };
}

/* -------------------------------------------------------------------------- */
/*                               Live API                                     */
/* -------------------------------------------------------------------------- */

export interface LiveSwapParams {
  chain: string;

  pair: string;

  walletId: string;

  type: "buy" | "sell";

  amountOrPercent: number;

  customFeeAndTip: boolean;

  priorityFee: string;

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
}

function buildLiveBuyParams(
  pair: string,
  amountSol: number,
  signal?: AveScannerSignal,
): LiveSwapParams {
  const tp =
    CONFIG.backstopTpPct > 0
      ? [
          {
            pricePercent: CONFIG.backstopTpPct,
            amountPercent: 1,
          },
        ]
      : undefined;

  return {
    chain: "solana",

    pair,

    walletId: CONFIG.walletId,

    type: "buy",

    amountOrPercent: amountSol,

    customFeeAndTip: CONFIG.customFeeAndTip,

    priorityFee: CONFIG.priorityFee,

    jitoEnabled: CONFIG.jitoEnabled,

    jitoTip: CONFIG.jitoTip,

    maxSlippage: CONFIG.maxSlippage,

    concurrentNodes: CONFIG.concurrentNodes,

    retries: CONFIG.retries,

    stopEarnGroup: tp,

    stopLossPercent: CONFIG.stopLossPct,

    pnlOrderExpireDelta: CONFIG.baseTtlSecs * 1000,

    pnlOrderExpireExecute: true,

    pnlOrderUseMidPrice: false,
  };
}

export async function liveBuy(
  pair: string,
  amountSol: number,
  signal?: AveScannerSignal,
): Promise<string> {
  const params = buildLiveBuyParams(pair, amountSol, signal);

  const result = await apiPost<{ id: string }>(
    `${CONFIG.baseUrl}/automation/swap_order`,
    params,
  );

  return result.id;
}

export async function liveSell(pair: string): Promise<string> {
  const params: LiveSwapParams = {
    chain: "solana",

    pair,

    walletId: CONFIG.walletId,

    type: "sell",

    amountOrPercent: 1,

    customFeeAndTip: CONFIG.customFeeAndTip,

    priorityFee: CONFIG.priorityFee,

    jitoEnabled: CONFIG.jitoEnabled,

    jitoTip: CONFIG.jitoTip,

    maxSlippage: CONFIG.maxSlippage,

    concurrentNodes: CONFIG.concurrentNodes,

    retries: CONFIG.retries,

    pnlOrderExpireDelta: 60000,

    pnlOrderExpireExecute: true,

    pnlOrderUseMidPrice: false,
  };

  const result = await apiPost<{ id: string }>(
    `${CONFIG.baseUrl}/automation/swap_order`,
    params,
  );

  return result.id;
}

export async function querySwapOrder(orderId: string): Promise<{
  state: string;
  txPriceUsd?: number;
} | null> {
  try {
    const orders = await apiGet<
      Array<{
        id: string;
        state: string;
        txPriceUsd?: number;
      }>
    >(CONFIG.baseUrl, `/automation/swap_orders?ids=${orderId}`);

    return orders[0] ?? null;
  } catch {
    return null;
  }
}

export async function pollOrderUntilDone(
  orderId: string,
  attempts = 20,
  interval = 2000,
) {
  for (let i = 0; i < attempts; i++) {
    const order = await querySwapOrder(orderId);

    if (order?.state === "done") return order;

    if (order?.state === "fail" || order?.state === "expired") {
      throw new Error(`Order failed: ${order.state}`);
    }

    await sleep(interval);
  }

  throw new Error(`Order timeout ${orderId}`);
}
