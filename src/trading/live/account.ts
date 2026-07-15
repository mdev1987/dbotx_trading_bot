import { BehaviorSubject } from "rxjs";
import { CONFIG } from "../../config";
import { dataHttp } from "../http";
import type { TradingAccount } from "../types";

interface WalletBalanceResponse {
  err: boolean;
  res: {
    account: string;
    amount: string;
    uiAmount: number;
  };
}

export interface LiveAccount {
  balance: number;
}

let liveAccount: LiveAccount = { balance: 0 };

export const liveAccount$ = new BehaviorSubject<LiveAccount>(liveAccount);

/** Fetch SOL balance from wallet-balance API (5 credits). Only call when really needed. */
export async function fetchLiveBalance(): Promise<LiveAccount> {
  try {
    const response = await dataHttp.get<WalletBalanceResponse>(
      `/kline/wallet/balance?chain=solana&walletAddress=${CONFIG.walletAddress}`,
    );

    if (response.err) {
      throw new Error("Wallet balance API returned an error.");
    }

    liveAccount = { balance: response.res.uiAmount };

    liveAccount$.next(liveAccount);
  } catch (error) {
    console.error("[LiveAccount] Failed to fetch balance:", error);
  }

  return liveAccount;
}

/** Force-refresh balance from API — call on startup, reconnect, or important events. */
export async function refreshLiveBalance(): Promise<LiveAccount> {
  return fetchLiveBalance();
}

/** Convert live account into the generic TradingAccount shape used by the handler. */
export function toTradingAccount(account: LiveAccount, solPriceUsd: number): TradingAccount {
  return {
    balance: account.balance * solPriceUsd,
    change24h: 0,
    changeAll: 0,
    holdTokens: 0,
  };
}

/** Snapshot of the latest cached balance (no API call). */
export function getLiveAccount(): LiveAccount {
  return liveAccount;
}
