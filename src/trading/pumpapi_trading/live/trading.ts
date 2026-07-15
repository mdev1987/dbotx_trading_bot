import { CONFIG } from "../../../config";
import { pumpapiHttp } from "../../http";
import {
  getPumpAccount,
  refreshPumpBalance,
  toTradingAccount,
} from "./account";

import type { OrderResult, TradingAccount, TradingApi } from "../../types";

// ============================================================================
// Types
// ============================================================================

/**
 * PumpAPI trade request.
 *
 * See:
 * https://pumpapi.io/
 */
interface PumpApiTradeRequest {
  /** Wallet private key used to sign the transaction. */
  privateKey: string;

  /** Trade direction. */
  action: "buy" | "sell";

  /** Token mint address. */
  mint: string;

  /**
   * Buy:
   *   Amount of SOL.
   *
   * Sell:
   *   Percentage string (e.g. "100%").
   */
  amount: number | string;

  /**
   * true  -> amount is denominated in SOL
   * false -> amount is denominated in tokens
   */
  denominatedInQuote: boolean;

  /** Maximum accepted slippage (1–99). */
  slippage: number;

  /** Optional priority fee in SOL. */
  priorityFee?: number;
}

/**
 * PumpAPI trade response.
 */
interface PumpApiTradeResponse {
  signature?: string;
  signatures?: string[];
  timestamp?: number;
  err?: string;
}

// ============================================================================
// Configuration Helpers
// ============================================================================

/**
 * Converts the application's slippage configuration into
 * PumpAPI's expected integer percentage.
 *
 * Example:
 *
 * 0.10 -> 10
 * 0.25 -> 25
 * 1.00 -> 99 (clamped)
 */
function parseSlippage(): number {
  const percent = Math.round(CONFIG.maxSlippage * 100);

  return Math.min(Math.max(percent, 1), 99);
}

/**
 * Parses the configured priority fee.
 *
 * Returns undefined when disabled.
 */
function parsePriorityFee(): number | undefined {
  const value = Number(CONFIG.priorityFee);

  return Number.isFinite(value) && value > 0 ? value : undefined;
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Ensures PumpAPI credentials are configured.
 */
function validateConfiguration(): void {
  if (!CONFIG.pumpapiPrivateKey) {
    throw new Error("PumpAPI private key is not configured.");
  }
}

/**
 * Validates a token mint.
 */
function validateMint(mint: string): void {
  if (!mint.trim()) {
    throw new Error("Token mint cannot be empty.");
  }
}

/**
 * Validates a buy amount.
 */
function validateBuyAmount(amount: number): void {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Buy amount must be greater than zero.");
  }
}

/**
 * Validates a sell percentage.
 */
function validateSellPercentage(percentage: number): void {
  if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 1) {
    throw new Error("Sell percentage must be between 0 and 1.");
  }
}

/**
 * Validates the PumpAPI response.
 */
function validateResponse(response: PumpApiTradeResponse): void {
  if (response.err) {
    throw new Error(response.err);
  }

  if (!response.signature && !response.signatures?.length) {
    throw new Error("PumpAPI did not return a transaction signature.");
  }
}

// ============================================================================
// Request Builders
// ============================================================================

/**
 * Creates an immutable PumpAPI trade request.
 */
function createTradeRequest(
  action: "buy" | "sell",
  mint: string,
  amount: number | string,
): Readonly<PumpApiTradeRequest> {
  validateConfiguration();
  validateMint(mint);

  return Object.freeze({
    privateKey: CONFIG.pumpapiPrivateKey,
    action,
    mint,
    amount,
    denominatedInQuote: true,
    slippage: parseSlippage(),
    priorityFee: parsePriorityFee(),
  });
}

/**
 * Returns the transaction signature.
 */
function getSignature(response: PumpApiTradeResponse): string {
  return response.signature ?? response.signatures?.[0] ?? "";
}

// ============================================================================
// Trade Execution
// ============================================================================

/**
 * Executes a trade through PumpAPI.
 *
 * This function is responsible for:
 *   - Building the request
 *   - Sending it to PumpAPI
 *   - Validating the response
 *   - Returning a normalized OrderResult
 */
async function submitTrade(
  action: "buy" | "sell",
  mint: string,
  amount: number | string,
): Promise<OrderResult> {
  const request = createTradeRequest(action, mint, amount);

  console.log(`[PumpAPI] ${action.toUpperCase()} ${mint.slice(0, 8)}...`);

  let response: PumpApiTradeResponse;

  try {
    response = await pumpapiHttp.post<PumpApiTradeResponse>("", request);
  } catch (error) {
    throw new Error(
      `PumpAPI ${action} request failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  validateResponse(response);

  const txHash = getSignature(response);

  console.log(
    `[PumpAPI] ${action.toUpperCase()} successful (${txHash.slice(0, 16)}...)`,
  );

  const amountSol =
    action === "buy" && typeof amount === "number" ? amount : undefined;

  return {
    id: txHash.slice(0, 16),
    status: "done",
    pair: "",
    type: action,
    price: undefined,
    amountSol,
    txHash,
    updatedAt: response.timestamp ?? Date.now(),
  };
}

// ============================================================================
// Trading API
// ============================================================================

/**
 * PumpAPI live trading implementation.
 */
export const pumpapiLiveTrading: TradingApi = {
  /**
   * Executes a market buy.
   */
  async buy(
    pair: string,
    amountSol: number,
    tokenName: string,
    mint: string,
  ): Promise<OrderResult> {
    validateBuyAmount(amountSol);

    return submitTrade("buy", mint, amountSol);
  },

  /**
   * Executes a market sell.
   *
   * PumpAPI expects the amount as a percentage
   * string ("25%", "100%", etc.).
   */
  async sell(
    pair: string,
    percentage: number,
    tokenName: string,
    mint: string,
  ): Promise<OrderResult> {
    validateSellPercentage(percentage);

    const amount = `${Math.round(percentage * 100)}%`;

    return submitTrade("sell", mint, amount);
  },

  /**
   * Returns the current trading account.
   *
   * If the balance has not yet been loaded,
   * refresh it from PumpAPI.
   */
  async getAccount(): Promise<TradingAccount> {
    if (!getPumpAccount().balance) {
      await refreshPumpBalance();
    }

    return toTradingAccount(getPumpAccount());
  },

  /**
   * Gracefully shuts down the trading adapter.
   *
   * Reserved for future cleanup such as:
   *   - pending orders
   *   - metrics
   *   - WebSocket connections
   */
  async shutdown(): Promise<void> {
    console.log("[PumpAPI] Trading adapter stopped.");
  },
};
