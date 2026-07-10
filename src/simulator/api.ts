import { CONFIG } from "../config";
import type { SimAccount, SwapOrderResult } from "../data_stream/types";
import type { TradingApi } from "../strategy/api";

const BASE = CONFIG.baseUrl;
const KEY = CONFIG.dbotxApiKey;

async function apiFetch<T>(
  path: string,
  options?: { method?: string; body?: unknown },
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.httpTimeoutMs);

  try {
    const res = await fetch(`${BASE}${path}`, {
      method: options?.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": KEY,
      },
      body: options?.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(
        `Sim API HTTP ${res.status}: ${options?.method ?? "GET"} ${path} ${res.statusText}`,
      );
    }

    const data = (await res.json()) as Record<string, unknown>;
    const maybeErr = data as { err?: boolean; res?: unknown };
    if ("err" in data) {
      if (maybeErr.err) throw new Error(`Sim API error: ${path}`);
      if (maybeErr.res !== undefined) return maybeErr.res as T;
    }

    // Response not wrapped in { err, res } — use raw data
    return data as T;
  } finally {
    clearTimeout(timeout);
  }
}

const apiPost = <T>(path: string, body: unknown) =>
  apiFetch<T>(path, { method: "POST", body });

const apiGet = <T>(path: string) => apiFetch<T>(path);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface SwapTrade {
  _id: string;
  type: string;
  state: string;
  pair: string;
  priceUsd?: string;
  send: { amount: string; info?: { decimals?: number } };
  receive: { amount: string; info?: { decimals?: number } };
  links?: { dexscreener?: string };
}

function extractTrades(raw: unknown): SwapTrade[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.trades)) return obj.trades as SwapTrade[];
    if (Array.isArray(obj.data)) return obj.data as SwapTrade[];
    if (Array.isArray(obj.list)) return obj.list as SwapTrade[];
  }
  return [];
}

function computePriceUsd(trade: SwapTrade): number | undefined {
  // API returns priceUsd directly when available (simulator UI Price column)
  if (trade.priceUsd != null) {
    const p = parseFloat(trade.priceUsd);
    if (Number.isFinite(p) && p > 0) return p;
  }

  // Fallback: compute from send/receive amounts (SOL/token)
  const sendLamports = parseInt(trade.send.amount, 10);
  const sendDecimals = trade.send.info?.decimals ?? 9;
  const sendAmount = sendLamports / Math.pow(10, sendDecimals);
  if (!sendAmount || sendAmount <= 0) return undefined;

  const receiveLamports = parseInt(trade.receive.amount, 10);
  const receiveDecimals = trade.receive.info?.decimals ?? 6;
  const receiveAmount = receiveLamports / Math.pow(10, receiveDecimals);
  if (!receiveAmount || receiveAmount <= 0) return undefined;

  const isBuy = trade.type === "buy";
  return isBuy
    ? sendAmount / receiveAmount    // SOL/token
    : receiveAmount / sendAmount;   // SOL/token
}

async function pollOrderUntilDone(
  orderId: string,
  maxAttempts = CONFIG.maxSwapOrderPollAttempts,
  intervalMs = CONFIG.swapOrderPollMs,
): Promise<SwapOrderResult> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const page = Math.floor(i / 5);
      const raw = await apiGet<unknown>(
        `/simulator/swap_trades?chain=&page=${page}&size=20&wallet=&token=`,
      );
      const trades = extractTrades(raw);
      const match = trades.find((t) => t._id === orderId);

      if (!match) {
        await sleep(intervalMs);
        continue;
      }

      if (match.state === "done" || match.state === "completed" || match.state === "success") {
        return {
          id: orderId,
          state: "done",
          priceUsd: computePriceUsd(match),
          sendAmount: match.send.amount,
          receiveAmount: match.receive.amount,
        };
      }

      if (match.state === "fail" || match.state === "failed" || match.state === "expired") {
        throw new Error(`Sim order ${orderId} ${match.state}`);
      }
    } catch (e) {
      if (e instanceof Error && /sim order.*(fail|expired|failed)/i.test(e.message))
        throw e;
    }

    await sleep(intervalMs);
  }

  throw new Error(
    `Sim order ${orderId} did not complete within ${maxAttempts} polls`,
  );
}

async function submitBuyOrder(
  pair: string,
  amountSol: number,
): Promise<string> {
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
  return id;
}

export const simulatorApi: TradingApi = {
  async submitBuy(pair, amountSol, _tokenName, _tokenCA): Promise<string> {
    const id = await submitBuyOrder(pair, amountSol);
    console.log(`[Sim] Buy order submitted: ${id}`);
    return id;
  },

  async waitForOrder(orderId): Promise<SwapOrderResult> {
    const result = await pollOrderUntilDone(orderId);

    if (!result.priceUsd) {
      console.warn(`[Sim] No price data for order ${orderId}, using fallback`);
    }

    return {
      id: result.id ?? orderId,
      state: "done",
      priceUsd: result.priceUsd,
      sendAmount: result.sendAmount,
      receiveAmount: result.receiveAmount,
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
