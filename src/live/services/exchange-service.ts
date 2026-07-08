import { LIVE_CONFIG } from "../config";
import { postJson, getJson } from "../http";
import type { IExchangeService } from "../../core/interfaces";
import type { ParsedSignal } from "../../telegram/telegram_listener";
import type {
  LiveSwapOrderResponse,
  LiveSwapOrderInfo,
} from "../types";
import { appendAuditLog, updateAuditLog } from "../persistence";

/** Fee configuration for swap transactions */
interface FeeConfig {
  customFeeAndTip: boolean; // Whether to use custom fee + tip settings
  priorityFee: string;      // Priority fee level for the transaction
  gasFeeDelta: number;      // Delta applied to estimated gas fee
  maxFeePerGas: number;     // Maximum fee per gas unit
  jitoEnabled: boolean;     // Whether Jito tip is enabled for MEV protection
  jitoTip: number;          // Jito tip amount in SOL
  maxSlippage: number;      // Maximum allowed slippage percentage
  concurrentNodes: number;  // Number of concurrent RPC nodes to use
  retries: number;          // Number of retry attempts on failure
}

/** A PnL tier defining a price target and the fraction of the position to sell at that target */
export interface PnLTier {
  pricePercent: number;  // Price change percentage that triggers the tier
  amountPercent: number; // Fraction (0-1) of position to sell at this tier
}

/** Parameters for placing a swap order through the live exchange API */
export interface LiveSwapOrderParams {
  chain: string;                                          // Blockchain identifier (e.g. "solana")
  pair: string;                                           // Trading pair symbol
  walletId: string;                                       // Wallet ID to execute the trade
  type: "buy" | "sell";                                   // Order direction
  amountOrPercent: number;                                // Amount (in SOL) or percentage (for sells)
  customFeeAndTip: boolean;                               // Whether to use custom fee + tip settings
  priorityFee: string;                                    // Priority fee level
  gasFeeDelta: number;                                    // Delta applied to estimated gas fee
  maxFeePerGas: number;                                   // Maximum fee per gas unit
  jitoEnabled: boolean;                                   // Whether Jito is enabled
  jitoTip: number;                                        // Jito tip amount in SOL
  maxSlippage: number;                                    // Maximum allowed slippage percentage
  concurrentNodes: number;                                // Number of concurrent RPC nodes
  retries: number;                                        // Number of retry attempts
  migrateSellPercent?: number;                            // % of position to sell on migration detected
  minDevSellPercent?: number;                             // Minimum % to sell when dev sells
  devSellPercent?: number;                                // % to sell when dev sells
  stopEarnPercent?: number;                               // Take-profit percentage (legacy single-tier)
  stopLossPercent?: number;                               // Stop-loss percentage
  stopEarnGroup?: PnLTier[];                              // Multi-tier take-profit targets
  stopLossGroup?: PnLTier[];                              // Multi-tier stop-loss targets
  trailingStopGroup?: { pricePercent: number; amountPercent: number; activePricePercent: number }[]; // Trailing stop config
  pnlOrderExpireDelta: number;                            // Time in ms before PnL order expires
  pnlOrderExpireExecute: boolean;                         // Whether to execute the expiry action
  pnlOrderUseMidPrice: boolean;                           // Whether to use mid-price for PnL evaluation
  pnlCustomConfigEnabled: boolean;                        // Whether custom PnL fee config is active
  pnlCustomConfig?: FeeConfig;                            // Custom fee config for PnL orders
}

/** Service for executing and monitoring swap orders via the live trading API */
export class LiveExchangeService implements IExchangeService {
  /**
   * Place a buy order for the given pair
   * @param pair - Trading pair symbol
   * @param amountSol - Amount of SOL to spend
   * @param signal - Optional parsed Telegram signal for TP tier calculation
   * @returns The order ID from the API
   */
  async buy(pair: string, amountSol: number, signal?: ParsedSignal): Promise<string> {
    const params = this.buildBuyParams(pair, amountSol, signal); // Build the full buy order payload
    return this.createOrder(params);                             // Submit the order to the API
  }

  /**
   * Place a sell order for the given pair (sells entire position)
   * @param pair - Trading pair symbol
   * @returns The order ID from the API
   */
  async sell(pair: string): Promise<string> {
    const params = this.buildSellParams(pair); // Build the full sell order payload
    return this.createOrder(params);           // Submit the order to the API
  }

  /**
   * Query a single swap order by ID
   * @param orderId - The order ID to look up
   * @returns The order state and optional tx price, or null if not found
   */
  async queryOrder(orderId: string): Promise<{ state: string; txPriceUsd?: number } | null> {
    const orders = await this.queryOrders([orderId]); // Delegate to batch query
    return orders[0] ?? null;                         // Return first result or null
  }

  /**
   * Query multiple swap orders by their IDs
   * @param orderIds - Array of order IDs to look up
   * @returns Array of order info objects
   */
  async queryOrders(orderIds: string[]): Promise<{ id: string; state: string; txPriceUsd?: number }[]> {
    if (orderIds.length === 0) return [];                     // Short-circuit for empty input
    const idsParam = orderIds.join(",");                      // Serialize IDs into a comma-separated string
    const url = `${LIVE_CONFIG.baseUrl}/automation/swap_orders?ids=${encodeURIComponent(idsParam)}`; // Build request URL
    interface SwapOrdersResponse {
      err: boolean;
      res: LiveSwapOrderInfo[];
    }
    const body = await getJson<SwapOrdersResponse>(url);      // Fetch order data from API
    if (body.err) throw new Error("Swap orders API returned err: true"); // Handle API error flag
    return body.res;                                           // Return the list of orders
  }

  /**
   * Poll for an order until it reaches a terminal state or max attempts are exhausted
   * @param orderId - The order ID to poll
   * @param maxAttempts - Maximum number of polling attempts
   * @param intervalMs - Delay between poll attempts in ms
   * @returns The transaction price if available
   */
  async pollUntilDone(
    orderId: string,
    maxAttempts: number = LIVE_CONFIG.maxSwapOrderPollAttempts,
    intervalMs: number = LIVE_CONFIG.swapOrderPollMs,
  ): Promise<{ txPriceUsd?: number }> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const order = await this.queryOrder(orderId);  // Fetch current order state
      if (!order) {
        await this.sleep(intervalMs); // Order not found yet — wait and retry
        continue;
      }
      if (order.state === "done") return order;       // Order completed successfully
      if (order.state === "fail" || order.state === "expired") {
        throw new Error(`Order ${orderId} ${order.state}`); // Terminal failure state
      }
      await this.sleep(intervalMs); // Still pending — wait before next poll
    }
    throw new Error(`Order ${orderId} did not complete within ${maxAttempts} polls`); // Timed out
  }

  /**
   * Submit a swap order to the live API and record it in the audit log
   * @param params - The complete swap order parameters
   * @returns The order ID returned by the API
   */
  private async createOrder(params: LiveSwapOrderParams): Promise<string> {
    const url = `${LIVE_CONFIG.baseUrl}/automation/swap_order`; // API endpoint for swap orders
    const auditId = appendAuditLog(                              // Create an audit log entry before sending
      params.type,                // Buy or sell direction
      params.pair,                // Trading pair
      params.type === "buy" ? params.amountOrPercent : undefined, // Log amount for buys only
      JSON.stringify(params),     // Full request payload as JSON
    );

    try {
      const body = await postJson<LiveSwapOrderResponse>(url, params, { retryNonIdempotent: false }); // POST order to API
      if (body.err || !body.res?.id) {
        const errMsg = body.err
          ? `Live API rejected ${params.type} order for ${params.pair}`
          : "Live API returned invalid response (no order ID)";
        updateAuditLog(auditId, "failed", undefined, JSON.stringify(body), errMsg); // Mark audit entry as failed
        throw new Error(errMsg);
      }
      updateAuditLog(auditId, "sent", body.res.id, JSON.stringify(body)); // Mark audit entry as sent with the order ID
      return body.res.id;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      updateAuditLog(auditId, "error", undefined, undefined, errMsg); // Record the error in the audit log
      throw err;                                                       // Re-throw so caller sees the failure
    }
  }

  /**
   * Build the full order parameters for a buy, including PnL tiers, trailing stop, and fee config
   * @param pair - Trading pair symbol
   * @param amountSol - Amount of SOL to spend
   * @param signal - Optional parsed signal for max-pump-based backstop calculation
   * @returns Complete LiveSwapOrderParams for a buy
   */
  private buildBuyParams(pair: string, amountSol: number, signal?: ParsedSignal): LiveSwapOrderParams {
    const { partialTpEnabled, partialTpTiers, backstopTpPct } = LIVE_CONFIG; // Destructure relevant config values
    const stopEarnGroup: PnLTier[] = [];                                      // Array to hold take-profit tiers

    if (partialTpEnabled) {
      // Build tiers from the configured partial take-profit levels
      for (const tier of partialTpTiers) {
        stopEarnGroup.push({ pricePercent: tier.at, amountPercent: tier.pct });
      }
      // Calculate a backstop tier based on the signal's maxPumpX or the configured backstop TP %
      const maxPumpX = (signal as { maxPumpX?: number })?.maxPumpX;
      const effectiveBackstop = maxPumpX && maxPumpX > 0 ? (maxPumpX - 1) * 0.7 : backstopTpPct;
      if (effectiveBackstop > 0) {
        const soldSoFar = partialTpTiers.reduce((sum, t) => sum + t.pct, 0); // Sum of already-allocated percentages
        const remaining = 1 - soldSoFar;                                      // Remaining position fraction
        if (remaining > 0.001) {
          stopEarnGroup.push({ pricePercent: effectiveBackstop, amountPercent: remaining }); // Add backstop tier
        }
      }
    } else if (backstopTpPct > 0) {
      // Single-tier TP: sell everything at the backstop percentage
      stopEarnGroup.push({ pricePercent: backstopTpPct, amountPercent: 1 });
    }

    // Build trailing stop configuration if enabled (non-zero percentage)
    const trailingStopGroup = LIVE_CONFIG.trailingStopPct > 0
      ? [{ pricePercent: LIVE_CONFIG.trailingStopPct, amountPercent: 1, activePricePercent: LIVE_CONFIG.trailingActivationPct }]
      : undefined;

    // PnL order expiry delta: use the smaller of the configured delta and the base TTL
    const expireDelta = Math.min(LIVE_CONFIG.pnlOrderExpireDeltaMs, LIVE_CONFIG.baseTtlSecs * 1000);
    const baseFeeConfig: FeeConfig = {
      customFeeAndTip: LIVE_CONFIG.customFeeAndTip,
      priorityFee: LIVE_CONFIG.priorityFee,
      gasFeeDelta: 5,
      maxFeePerGas: 100,
      jitoEnabled: LIVE_CONFIG.jitoEnabled,
      jitoTip: LIVE_CONFIG.jitoTip,
      maxSlippage: LIVE_CONFIG.maxSlippage,
      concurrentNodes: LIVE_CONFIG.concurrentNodes,
      retries: LIVE_CONFIG.retries,
    };

    return {
      chain: "solana",
      pair,
      walletId: LIVE_CONFIG.walletId,
      type: "buy",
      amountOrPercent: amountSol,
      ...baseFeeConfig,                         // Spread all base fee/tip/slippage settings
      migrateSellPercent: LIVE_CONFIG.migrateSellPercent,
      minDevSellPercent: LIVE_CONFIG.minDevSellPercent,
      devSellPercent: LIVE_CONFIG.devSellPercent,
      stopEarnGroup: stopEarnGroup.length > 0 ? stopEarnGroup : undefined, // Only include if tiers exist
      stopLossPercent: LIVE_CONFIG.stopLossPct,
      trailingStopGroup,
      pnlOrderExpireDelta: expireDelta,
      pnlOrderExpireExecute: LIVE_CONFIG.pnlOrderExpireExecute,
      pnlOrderUseMidPrice: LIVE_CONFIG.pnlOrderUseMidPrice,
      pnlCustomConfigEnabled: true,             // Enable custom fee config for follow-up PnL orders
      pnlCustomConfig: baseFeeConfig,           // Pass the same fee config for PnL orders
    };
  }

  /**
   * Build the full order parameters for a sell (sells 100% of the position)
   * @param pair - Trading pair symbol
   * @returns Complete LiveSwapOrderParams for a sell
   */
  private buildSellParams(pair: string): LiveSwapOrderParams {
    return {
      chain: "solana",
      pair,
      walletId: LIVE_CONFIG.walletId,
      type: "sell",
      amountOrPercent: 1,                  // Sell full position (100%)
      customFeeAndTip: LIVE_CONFIG.customFeeAndTip,
      priorityFee: LIVE_CONFIG.priorityFee,
      gasFeeDelta: 5,
      maxFeePerGas: 100,
      jitoEnabled: LIVE_CONFIG.jitoEnabled,
      jitoTip: LIVE_CONFIG.jitoTip,
      maxSlippage: LIVE_CONFIG.maxSlippage,
      concurrentNodes: LIVE_CONFIG.concurrentNodes,
      retries: LIVE_CONFIG.retries,
      pnlOrderExpireDelta: 60_000,         // 60-second expiry for sells
      pnlOrderExpireExecute: true,         // Execute expiry action
      pnlOrderUseMidPrice: false,          // Don't use mid-price for sells
      pnlCustomConfigEnabled: false,       // Disable custom PnL fee config on sells
    };
  }

  /** Async sleep helper that resolves after the given number of milliseconds */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
