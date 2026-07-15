import { CONFIG } from "../../../config";
import { getSolPriceUsd } from "../../../data_stream/price_engine";
import {
  getPaperAccount,
  updatePaperBalance,
  initPaperAccount,
  resetPaperAccount,
  toTradingAccount,
} from "./account";
import type { OrderResult, TradingAccount, TradingApi } from "../../types";

function getFillPrice(): number | undefined {
  const solPrice = getSolPriceUsd();
  return solPrice > 0 ? solPrice : undefined;
}

export const pumpapiPaperTrading: TradingApi = {
  async buy(pair: string, amountSol: number, tokenName: string, token: string): Promise<OrderResult> {
    const fillPrice = getFillPrice();
    if (!fillPrice) {
      throw new Error("Paper trading: no SOL price available");
    }

    const account = getPaperAccount();

    if (amountSol > account.balance) {
      throw new Error(
        `Paper trading: insufficient SOL (have ${account.balance.toFixed(4)} SOL, need ${amountSol.toFixed(4)} SOL)`,
      );
    }

    updatePaperBalance(account.balance - amountSol);

    console.log(
      `[PaperTrading] Buy ${tokenName} ${amountSol} SOL @ $${fillPrice} → bal: ${(account.balance - amountSol).toFixed(4)} SOL`,
    );

    return {
      id: `paper_${Date.now()}`,
      status: "done",
      pair,
      type: "buy",
      priceUsd: fillPrice,
      amountSol,
      updatedAt: Date.now(),
    };
  },

  async sell(pair: string, percentage: number, tokenName: string, token: string): Promise<OrderResult> {
    if (percentage <= 0 || percentage > 1) {
      throw new Error("Sell percentage must be between 0 and 1.");
    }

    const fillPrice = getFillPrice();
    if (!fillPrice) {
      throw new Error("Paper trading: no SOL price available");
    }

    console.log(
      `[PaperTrading] Sell ${tokenName} ${(percentage * 100).toFixed(0)}% @ $${fillPrice}`,
    );

    return {
      id: `paper_${Date.now()}`,
      status: "done",
      pair,
      type: "sell",
      priceUsd: fillPrice,
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
