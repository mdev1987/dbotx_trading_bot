import {
  getPaperAccount,
  initPaperAccount,
  resetPaperAccount,
  toTradingAccount,
  updatePaperAccount,
} from "./account";

import { positions } from "../../../strategy/positions_store";

import type { OrderResult, TradingAccount, TradingApi } from "../../types";
import { CONFIG } from "../../../config";

// ============================================================================
// Constants
// ============================================================================

/**
 * Sequential paper order identifier.
 *
 * Using an incrementing ID is easier to read during debugging than a
 * timestamp-based identifier.
 */
let nextOrderId = 1;

// ============================================================================
// Validation
// ============================================================================

/**
 * Ensures a buy amount is valid.
 */
function validateBuyAmount(amount: number): void {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Buy amount must be greater than zero.");
  }
}

/**
 * Ensures a sell percentage is valid.
 */
function validateSellPercentage(percentage: number): void {
  if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 1) {
    throw new Error("Sell percentage must be between 0 and 1.");
  }
}

/**
 * Ensures the paper wallet contains enough SOL.
 */
function validateBalance(balance: number, required: number): void {
  if (required > balance) {
    throw new Error(
      `Paper trading: insufficient SOL (have ${balance.toFixed(
        4,
      )} SOL, need ${required.toFixed(4)} SOL)`,
    );
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Creates a normalized paper order result.
 */
function createOrderResult(
  type: "buy" | "sell",
  pair: string,
  amountSol?: number,
  price?: number,
): OrderResult {
  return {
    id: `paper-${nextOrderId++}`,
    status: "done",

    pair,
    type,

    amountSol,
    price,

    updatedAt: Date.now(),
  };
}

/**
 * Calculates the proceeds from selling part (or all) of a position.
 */
function calculateSellProceeds(
  pair: string,
  percentage: number,
): {
  proceeds: number;
  price?: number;
} {
  const position = positions.get(pair);

  if (!position || position.entryPrice <= 0) {
    return {
      proceeds: 0,
    };
  }

  const exitPrice = position.currentPrice;

  const multiplier = exitPrice / position.entryPrice;

  return {
    proceeds: position.sizeSol * multiplier * percentage,

    price: exitPrice,
  };
}

// ============================================================================
// Paper Trading Adapter
// ============================================================================

/**
 * Paper trading implementation.
 *
 * This adapter simulates order execution without broadcasting transactions
 * to the Solana network. It only updates the local paper account.
 */
export const pumpapiPaperTrading: TradingApi = {
  /**
   * Simulates a market buy.
   */
  async buy(
    pair: string,
    amountSol: number,
    tokenName: string,
    mint: string,
  ): Promise<OrderResult> {
    validateBuyAmount(amountSol);

    const account = getPaperAccount();

    validateBalance(account.balance, amountSol);

    const newBalance = account.balance - amountSol;

    updatePaperAccount({
      balance: newBalance,
      equity: newBalance,
    });

    console.log(
      `[Paper] BUY ${tokenName} (${mint.slice(
        0,
        8,
      )}) ${amountSol.toFixed(4)} SOL`,
    );

    return createOrderResult("buy", pair, amountSol);
  },

  /**
   * Simulates a market sell.
   */
  async sell(
    pair: string,
    percentage: number,
    tokenName: string,
    mint: string,
  ): Promise<OrderResult> {
    validateSellPercentage(percentage);

    const account = getPaperAccount();

    const { proceeds, price } = calculateSellProceeds(pair, percentage);

    const newBalance = account.balance + proceeds;

    updatePaperAccount({
      balance: newBalance,
      equity: newBalance,
    });

    console.log(
      `[Paper] SELL ${tokenName} (${mint.slice(0, 8)}) ${(
        percentage * 100
      ).toFixed(0)}% → +${proceeds.toFixed(6)} SOL`,
    );

    return createOrderResult("sell", pair, undefined, price);
  },

  /**
   * Returns the latest paper trading account.
   */
  async getAccount(): Promise<TradingAccount> {
    return toTradingAccount(getPaperAccount());
  },

  /**
   * Stops the paper trading engine.
   */
  async shutdown(): Promise<void> {
    resetPaperAccount();

    nextOrderId = 1;

    console.log("[Paper] Trading adapter stopped.");
  },
};

// ============================================================================
// Initialization
// ============================================================================

/**
 * Initializes the paper trading wallet.
 *
 * If no balance is supplied, the configured default balance is used.
 */
export function initPaperTrading(
  startBalance = CONFIG.pumpapiPaperWalletBalanceSol,
): void {
  initPaperAccount(startBalance);

  nextOrderId = 1;

  console.log(`[Paper] Initialized with ${startBalance.toFixed(2)} SOL`);
}
