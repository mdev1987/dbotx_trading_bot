import { BehaviorSubject } from "rxjs";
import { CONFIG } from "../../../config";
import { pumpapiHttp } from "../../http";
import type { TradingAccount } from "../../types";

export interface PumpAccount {
  balance: number;
}

interface PumpBalancesResponse {
  solBalance?: number;
  tokenBalances?: Record<string, { balance: number; tokenProgram: string }>;
  err?: string;
  signature?: string;
}

let pumpAccount: PumpAccount = { balance: 0 };

export const pumpAccount$ = new BehaviorSubject<PumpAccount>(pumpAccount);

export async function fetchPumpBalance(): Promise<PumpAccount> {
  try {
    const response = await pumpapiHttp.post<PumpBalancesResponse>("", {
      action: "getBalances",
      privateKey: CONFIG.pumpapiPrivateKey,
    });

    if (response.err) {
      throw new Error(`PumpAPI balance error: ${response.err}`);
    }

    pumpAccount = { balance: response.solBalance ?? 0 };
    pumpAccount$.next(pumpAccount);
  } catch (error) {
    console.error("[PumpAccount] Failed to fetch balance:", error);
  }

  return pumpAccount;
}

export async function refreshPumpBalance(): Promise<PumpAccount> {
  return fetchPumpBalance();
}

export function toTradingAccount(account: PumpAccount): TradingAccount {
  return {
    balance: account.balance,
    change24h: 0,
    changeAll: 0,
    holdTokens: 0,
  };
}

export function getPumpAccount(): PumpAccount {
  return pumpAccount;
}
