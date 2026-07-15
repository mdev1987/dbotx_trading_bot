import { CONFIG } from "../../../config";
import {
  getPaperAccount,
  updatePaperBalance,
  initPaperAccount,
  resetPaperAccount,
  toTradingAccount,
} from "./account";
import type { OrderResult, TradingAccount, TradingApi } from "../../types";

export const pumpapiPaperTrading: TradingApi = {
  async buy(pair: string, amountSol: number, tokenName: string, token: string): Promise<OrderResult> {
    const account = getPaperAccount();

    if (amountSol > account.balance) {
      throw new Error(
        `Paper trading: insufficient SOL (have ${account.balance.toFixed(4)} SOL, need ${amountSol.toFixed(4)} SOL)`,
      );
    }

    updatePaperBalance(account.balance - amountSol);

    console.log(
      `[PaperTrading] Buy ${tokenName} ${amountSol} SOL → bal: ${(account.balance - amountSol).toFixed(4)} SOL`,
    );

    return {
      id: `paper_${Date.now()}`,
      status: "done",
      pair,
      type: "buy",
      amountSol,
      updatedAt: Date.now(),
    };
  },

  async sell(pair: string, percentage: number, tokenName: string, token: string): Promise<OrderResult> {
    if (percentage <= 0 || percentage > 1) {
      throw new Error("Sell percentage must be between 0 and 1.");
    }

    console.log(
      `[PaperTrading] Sell ${tokenName} ${(percentage * 100).toFixed(0)}%`,
    );

    return {
      id: `paper_${Date.now()}`,
      status: "done",
      pair,
      type: "sell",
      updatedAt: Date.now(),
    };
  },

  async getAccount(): Promise<TradingAccount> {
    return toTradingAccount(getPaperAccount());
  },

  async shutdown(): Promise<void> {
    resetPaperAccount();
    console.log("[PaperTrading] Shutdown complete");
  },
};

export function initPaperTrading(startBalanceSol?: number): void {
  const balance = startBalanceSol ?? 2;
  initPaperAccount(balance);
  console.log(`[PaperTrading] Initialized with ${balance} SOL`);
}
