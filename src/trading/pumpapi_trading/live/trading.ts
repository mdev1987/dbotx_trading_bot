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
 * Converts a decimal slippage value into PumpAPI's expected integer
 * percentage (1–99).
 *
 * Examples:
 *   0.10 -> 10
 *   0.25 -> 25
 *   1.00 -> 99 (clamped)
 */
function parseSlippage(base: number): number {
  const percent = Math.round(base * 100);
  return Math.min(Math.max(percent, 1), 99);
}

/**
 * Parses a priority fee string and checks whether custom fees are enabled.
 *
 * Returns undefined when:
 *  - `enabled` is false
 *  - the value is empty, NaN, or ≤ 0
 */
function parsePriorityFee(
  value: string,
  enabled: boolean,
): number | undefined {
  if (!enabled) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
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
 * Accepts pre-resolved slippage and priorityFee so the caller can use
 * entry- or exit-specific configuration.
 */
async function submitTrade(
  pair: string,
  action: "buy" | "sell",
  mint: string,
  amount: number | string,
  slippage: number,
  priorityFee: number | undefined,
): Promise<OrderResult> {
  validateConfiguration();
  validateMint(mint);

  const request: Readonly<PumpApiTradeRequest> = Object.freeze({
    privateKey: CONFIG.pumpapiPrivateKey,
    action,
    mint,
    amount,
    denominatedInQuote: true,
    slippage,
    priorityFee,
  });

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
    pair,
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

    return submitTrade(
      pair,
      "buy",
      mint,
      amountSol,
      parseSlippage(CONFIG.maxSlippage),
      parsePriorityFee(CONFIG.priorityFee, CONFIG.customFeeAndTip),
    );
  },

  /**
   * Executes a market sell.
   *
   * PumpAPI expects the amount as a percentage
   * string ("25%", "100%", etc.).
   *
   * When pnlCustomConfigEnabled is true, exit-specific fee and slippage
   * settings are used instead of the entry defaults.
   */
  async sell(
    pair: string,
    percentage: number,
    tokenName: string,
    mint: string,
  ): Promise<OrderResult> {
    validateSellPercentage(percentage);

    const amount = `${Math.round(percentage * 100)}%`;

    const useExitConfig = CONFIG.pnlCustomConfigEnabled;

    const slippage = parseSlippage(
      useExitConfig ? CONFIG.exitMaxSlippage : CONFIG.maxSlippage,
    );

    const priorityFee = parsePriorityFee(
      useExitConfig ? CONFIG.exitPriorityFee : CONFIG.priorityFee,
      useExitConfig ? CONFIG.exitCustomFeeAndTip : CONFIG.customFeeAndTip,
    );

    return submitTrade(pair, "sell", mint, amount, slippage, priorityFee);
  },

  /**
   * Returns the current trading account.
   *
   * Balance is cached for CONFIG.balanceTtlMs to avoid paying the
    * 10 000‑lamport getBalances fee on every call.
    */
  async getAccount(): Promise<TradingAccount> {
    const cached = getPumpAccount();

    if (
      !cached.balance ||
      Date.now() - cached.updatedAt > CONFIG.balanceTtlMs
    ) {
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
