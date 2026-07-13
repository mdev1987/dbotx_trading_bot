import { BehaviorSubject } from "rxjs";
import { CONFIG } from "../../config";
import { dataHttp } from "../http";
import type { TradingAccount } from "../types";

/* -------------------------------------------------------------------------- */
/*                                   Types                                    */
/* -------------------------------------------------------------------------- */

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
  holdTokens: number;
}

/* -------------------------------------------------------------------------- */
/*                               Account State                                */
/* -------------------------------------------------------------------------- */

let liveAccount: LiveAccount = {
  balance: 0,
  holdTokens: 0,
};

export const liveAccount$ = new BehaviorSubject<LiveAccount>(liveAccount);

/* -------------------------------------------------------------------------- */
/*                              Fetch Balance                                 */
/* -------------------------------------------------------------------------- */

export async function fetchLiveBalance(): Promise<LiveAccount> {
  try {
    const response = await dataHttp.get<WalletBalanceResponse>(
      `/kline/wallet/balance?chain=solana&walletAddress=${CONFIG.walletAddress}`,
    );

    if (response.err) {
      throw new Error("Wallet balance API returned an error.");
    }

    liveAccount = {
      balance: response.res.uiAmount,
      holdTokens: 0,
    };

    liveAccount$.next(liveAccount);
  } catch (error) {
    console.error("[LiveAccount] Failed to fetch balance:", error);
  }

  return liveAccount;
}

/* -------------------------------------------------------------------------- */
/*                            TradingAccount Adapter                          */
/* -------------------------------------------------------------------------- */

export function toTradingAccount(account: LiveAccount, solPriceUsd: number): TradingAccount {
  return {
    balance: account.balance * solPriceUsd,
    change24h: 0,
    changeAll: 0,
    holdTokens: account.holdTokens,
  };
}

/* -------------------------------------------------------------------------- */
/*                                   Getter                                   */
/* -------------------------------------------------------------------------- */

export function getLiveAccount(): LiveAccount {
  return liveAccount;
}


