import { BehaviorSubject } from "rxjs";
import { CONFIG } from "../../../config";
import { dataHttp } from "../../http";
import type { TradingAccount } from "../../types";

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

export async function refreshLiveBalance(): Promise<LiveAccount> {
  return fetchLiveBalance();
}

export function toTradingAccount(account: LiveAccount): TradingAccount {
  return {
    balance: account.balance,
    currency: "SOL",
    changeAll: 0,
  };
}

export function getLiveAccount(): LiveAccount {
  return liveAccount;
}
