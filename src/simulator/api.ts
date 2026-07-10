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
        `Sim API HTTP ${res.status}: POST ${path} ${res.statusText}`,
      );
    }

    const json = (await res.json()) as { err: boolean; res: T };
    if (json.err) throw new Error(`Sim API error: POST ${path}`);
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
        `Sim API HTTP ${res.status}: GET ${path} ${res.statusText}`,
      );
    }

    const json = (await res.json()) as { err: boolean; res: T };
    if (json.err) throw new Error(`Sim API error: GET ${path}`);
    return json.res;
  } finally {
    clearTimeout(timeout);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface SimTask {
  id: string;
  state: string;
  type?: string;
  priceUsd?: number;
  send?: { amount: string };
  receive?: { amount: string };
}

async function pollOrderUntilDone(
  orderId: string,
  maxAttempts = CONFIG.maxSwapOrderPollAttempts,
  intervalMs = CONFIG.swapOrderPollMs,
): Promise<SwapOrderResult> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const tasks = await apiGet<SimTask[]>(
        `/simulator/list_tasks?chain=solana&page=0&size=20`,
      );
      const match = tasks.find((t) => t.id === orderId);

      if (!match) {
        await sleep(intervalMs);
        continue;
      }

      if (match.state === "done" || match.state === "completed") {
        const priceUsd = match.priceUsd;
        return {
          id: orderId,
          state: "done",
          priceUsd,
          sendAmount: match.send?.amount,
          receiveAmount: match.receive?.amount,
        };
      }

      if (match.state === "fail" || match.state === "expired") {
        throw new Error(`Sim order ${orderId} ${match.state}`);
      }
    } catch (e) {
      if (e instanceof Error && /sim order.*(fail|expired)/i.test(e.message))
        throw e;
    }

    await sleep(intervalMs);
  }

  throw new Error(
    `Sim order ${orderId} did not complete within ${maxAttempts} polls`,
  );
}

export const simulatorApi: TradingApi = {
  async buy(pair, amountSol, _tokenName, _tokenCA): Promise<SwapOrderResult> {
    const body = {
      chain: "solana",
      pair,
      walletId: "",
      type: "buy",
      amountOrPercent: amountSol,
      stopEarnPercent: null,
      stopLossPercent: null,
      stopEarnGroup: CONFIG.partialTpEnabled ? buildPartialTpGroup() : null,
      stopLossGroup: buildStopLossGroup(),
      priorityFee: "",
      gasFeeDelta: 5,
      maxFeePerGas: 100,
      slippage: CONFIG.defaultSlippage,
    };

    const { id } = await apiPost<{ id: string }>(
      "/simulator/sim_swap_order",
      body,
    );
    console.log(`[Sim] Buy order submitted: ${id}`);

    const result = await pollOrderUntilDone(id);

    if (!result.priceUsd) {
      console.warn(`[Sim] No price data for buy ${id}, using fallback`);
    }

    return {
      id: result.id ?? id,
      state: "done",
      priceUsd: result.priceUsd,
      totalUsd: result.priceUsd ? amountSol * result.priceUsd : undefined,
    };
  },

  async sell(pair, amountPercent): Promise<SwapOrderResult> {
    const body = {
      chain: "solana",
      pair,
      walletId: "",
      type: "sell",
      amountOrPercent: amountPercent,
      priorityFee: "",
      gasFeeDelta: 5,
      maxFeePerGas: 100,
      slippage: CONFIG.defaultSlippage,
    };

    const { id } = await apiPost<{ id: string }>(
      "/simulator/sim_swap_order",
      body,
    );
    console.log(`[Sim] Sell order submitted: ${id}`);

    const result = await pollOrderUntilDone(id);

    return {
      id: result.id ?? id,
      state: "done",
      priceUsd: result.priceUsd,
    };
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

function buildPartialTpGroup(): Array<{
  pricePercent: number;
  amountPercent: number;
}> {
  const tiers = CONFIG.partialTpTiers;
  if (tiers.length === 0) return [];

  return tiers.map((t) => ({
    pricePercent: t.at,
    amountPercent: t.pct,
  }));
}

function buildStopLossGroup(): Array<{
  pricePercent: number;
  amountPercent: number;
}> | null {
  if (!CONFIG.stopLossPct) return null;
  return [{ pricePercent: Math.abs(CONFIG.stopLossPct), amountPercent: 1 }];
}
