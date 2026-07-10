import { CONFIG } from "../config";
import type { SimAccount, SwapOrderResult } from "../data_stream/types";
import type { TradingApi } from "../strategy/api";

const BASE = CONFIG.baseUrl;
const KEY = CONFIG.dbotxApiKey;

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.httpTimeoutMs);

  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": KEY,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(
        `Live API HTTP ${res.status}: POST ${path} ${res.statusText}`,
      );
    }

    const json = (await res.json()) as { err: boolean; res: T };
    if (json.err) throw new Error(`Live API error: POST ${path}`);
    return json.res;
  } finally {
    clearTimeout(timeout);
  }
}

async function apiGet<T>(path: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.httpTimeoutMs);

  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { "x-api-key": KEY },
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(
        `Live API HTTP ${res.status}: GET ${path} ${res.statusText}`,
      );
    }

    const json = (await res.json()) as { err: boolean; res: T };
    if (json.err) throw new Error(`Live API error: GET ${path}`);
    return json.res;
  } finally {
    clearTimeout(timeout);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollLiveOrder(
  orderId: string,
  maxAttempts = CONFIG.maxSwapOrderPollAttempts,
  intervalMs = CONFIG.swapOrderPollMs,
): Promise<SwapOrderResult> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const orders = await apiGet<
        Array<{ id: string; state: string; txPriceUsd?: number }>
      >(`/automation/swap_orders?ids=${encodeURIComponent(orderId)}`);
      const order = orders[0];
      if (!order) {
        await sleep(intervalMs);
        continue;
      }
      if (order.state === "done") {
        return { id: order.id, state: "done", priceUsd: order.txPriceUsd };
      }
      if (order.state === "fail" || order.state === "expired") {
        throw new Error(`Live order ${orderId} ${order.state}`);
      }
    } catch (e) {
      if (e instanceof Error && /live order.*(fail|expired)/i.test(e.message))
        throw e;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `Live order ${orderId} did not complete within ${maxAttempts} polls`,
  );
}

async function submitLiveBuy(
  pair: string,
  amountSol: number,
): Promise<string> {
  const body = {
    chain: "solana",
    pair,
    walletId: CONFIG.walletId,
    type: "buy",
    amountOrPercent: amountSol,
    customFeeAndTip: CONFIG.customFeeAndTip,
    priorityFee: CONFIG.priorityFee,
    gasFeeDelta: 5,
    maxFeePerGas: 100,
    jitoEnabled: CONFIG.jitoEnabled,
    jitoTip: CONFIG.jitoTip,
    maxSlippage: CONFIG.maxSlippage,
    concurrentNodes: CONFIG.concurrentNodes,
    retries: CONFIG.retries,
    migrateSellPercent: CONFIG.migrateSellPercent,
    minDevSellPercent: CONFIG.minDevSellPercent,
    devSellPercent: CONFIG.devSellPercent,
    stopEarnGroup: buildPartialTpGroup(),
    stopLossPercent: CONFIG.stopLossPct,
    trailingStopGroup: buildTrailingStopGroup(),
    pnlOrderExpireDelta: Math.min(
      CONFIG.pnlOrderExpireDeltaMs,
      CONFIG.baseTtlSecs * 1000,
    ),
    pnlOrderExpireExecute: CONFIG.pnlOrderExpireExecute,
    pnlOrderUseMidPrice: CONFIG.pnlOrderUseMidPrice,
    pnlCustomConfigEnabled: true,
    pnlCustomConfig: {
      customFeeAndTip: CONFIG.customFeeAndTip,
      priorityFee: CONFIG.priorityFee,
      gasFeeDelta: 5,
      maxFeePerGas: 100,
      jitoEnabled: CONFIG.jitoEnabled,
      jitoTip: CONFIG.jitoTip,
      maxSlippage: CONFIG.maxSlippage,
      concurrentNodes: CONFIG.concurrentNodes,
      retries: CONFIG.retries,
    },
  };

  const { id } = await apiPost<{ id: string }>(
    "/automation/swap_order",
    body,
  );
  return id;
}

export const liveApi: TradingApi = {
  async submitBuy(pair, amountSol, _tokenName, _tokenCA): Promise<string> {
    const id = await submitLiveBuy(pair, amountSol);
    console.log(`[Live] Buy order submitted: ${id}`);
    return id;
  },

  async waitForOrder(orderId): Promise<SwapOrderResult> {
    const result = await pollLiveOrder(orderId);
    return { ...result, id: orderId };
  },

  async sell(pair, amountPercent): Promise<SwapOrderResult> {
    const body = {
      chain: "solana",
      pair,
      walletId: CONFIG.walletId,
      type: "sell",
      amountOrPercent: amountPercent,
      customFeeAndTip: CONFIG.customFeeAndTip,
      priorityFee: CONFIG.priorityFee,
      gasFeeDelta: 5,
      maxFeePerGas: 100,
      jitoEnabled: CONFIG.jitoEnabled,
      jitoTip: CONFIG.jitoTip,
      maxSlippage: CONFIG.maxSlippage,
      concurrentNodes: CONFIG.concurrentNodes,
      retries: CONFIG.retries,
      pnlOrderExpireDelta: 60_000,
      pnlOrderExpireExecute: true,
      pnlOrderUseMidPrice: false,
      pnlCustomConfigEnabled: false,
    };

    const { id } = await apiPost<{ id: string }>(
      "/automation/swap_order",
      body,
    );
    console.log(`[Live] Sell order submitted: ${id}`);

    const result = await pollLiveOrder(id);
    return { ...result, id };
  },

  async getAccountInfo(): Promise<SimAccount> {
    const res = await apiGet<{
      balance: string;
      change24h: number;
      changeAll: number;
      holdTokens: number;
    }>("/simulator/sim_account");

    return {
      balance: parseFloat(res.balance),
      change24h: res.change24h,
      changeAll: res.changeAll,
      holdTokens: res.holdTokens,
    };
  },
};

function buildPartialTpGroup():
  | Array<{ pricePercent: number; amountPercent: number }>
  | undefined {
  const tiers = CONFIG.partialTpTiers;
  if (!CONFIG.partialTpEnabled || tiers.length === 0) return undefined;
  return tiers.map((t) => ({ pricePercent: t.at, amountPercent: t.pct }));
}

function buildTrailingStopGroup():
  | Array<{
      pricePercent: number;
      amountPercent: number;
      activePricePercent: number;
    }>
  | undefined {
  if (CONFIG.trailingDistancePct <= 0) return undefined;
  return [
    {
      pricePercent: CONFIG.trailingDistancePct,
      amountPercent: 1,
      activePricePercent: CONFIG.trailingActivationPct,
    },
  ];
}
