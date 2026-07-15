import { CONFIG } from "../../../config";
import { pumpapiHttp } from "../../http";
import { getPumpAccount, refreshPumpBalance, toTradingAccount } from "./account";
import type { OrderResult, TradingAccount, TradingApi } from "../../types";

interface PumpApiTradeRequest {
  privateKey: string;
  action: "buy" | "sell";
  mint: string;
  amount: number | string;
  denominatedInQuote: boolean;
  slippage: number;
  priorityFee?: number;
}

interface PumpApiTradeResponse {
  signature?: string;
  signatures?: string[];
  err: string;
  timestamp?: number;
}

function parseSlippage(): number {
  const slippage = CONFIG.maxSlippage;
  if (slippage <= 0) return 99;
  const pct = slippage * 100;
  return Math.min(Math.max(Math.round(pct), 1), 99);
}

function parsePriorityFee(): number | undefined {
  const raw = CONFIG.priorityFee;
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

async function submitTrade(
  action: "buy" | "sell",
  token: string,
  amount: number | string,
): Promise<OrderResult> {
  if (!CONFIG.pumpapiPrivateKey) {
    throw new Error("PumpAPI private key not configured");
  }

  const body: PumpApiTradeRequest = {
    privateKey: CONFIG.pumpapiPrivateKey,
    action,
    mint: token,
    amount,
    denominatedInQuote: true,
    slippage: parseSlippage(),
    priorityFee: parsePriorityFee(),
  };

  console.log(`[PumpApiLive] Submitting ${action} for ${token.slice(0, 8)}...`);

  let response: PumpApiTradeResponse;
  try {
    response = await pumpapiHttp.post<PumpApiTradeResponse>("", body);
  } catch (err) {
    throw new Error(`PumpAPI ${action} request failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (response.err) {
    throw new Error(`PumpAPI ${action} failed: ${response.err}`);
  }

  const txHash = response.signature ?? response.signatures?.[0] ?? "";

  console.log(`[PumpApiLive] ${action} ${token.slice(0, 8)} done tx=${txHash.slice(0, 16)}...`);

  return {
    id: txHash.slice(0, 16),
    status: "done",
    pair: "",
    type: action,
    priceUsd: undefined,
    amountSol: action === "buy" ? (typeof amount === "number" ? amount : undefined) : undefined,
    txHash,
    updatedAt: Date.now(),
  };
}

export const pumpapiLiveTrading: TradingApi = {
  async buy(pair: string, amountSol: number, tokenName: string, token: string): Promise<OrderResult> {
    if (!token) throw new Error("PumpAPI buy requires token address (mint)");
    return submitTrade("buy", token, amountSol);
  },

  async sell(pair: string, percentage: number, tokenName: string, token: string): Promise<OrderResult> {
    if (!token) throw new Error("PumpAPI sell requires token address (mint)");
    if (percentage <= 0 || percentage > 1) {
      throw new Error("Sell percentage must be between 0 and 1.");
    }
    const pct = Math.round(percentage * 100);
    return submitTrade("sell", token, `${pct}%`);
  },

  async getAccount(): Promise<TradingAccount> {
    const account = getPumpAccount();
    if (account.balance === 0) {
      await refreshPumpBalance();
    }
    return toTradingAccount(account);
  },

  async shutdown(): Promise<void> {
    console.log("[PumpApiLive] Shutting down");
  },
};
