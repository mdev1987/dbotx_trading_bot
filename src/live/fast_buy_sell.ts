/**
 * DBotX Live Trading — Fast Buy / Sell API wrapper.
 *
 * Uses the REST API for order creation and status polling:
 *   POST /automation/swap_order    → creates a buy or sell order
 *   GET  /automation/swap_orders   → queries order status(es)
 *
 * TP/SL is configured at order creation time (server-managed).
 * The response only returns the order ID; actual execution is async.
 *
 * The bot must poll GET /automation/swap_orders?ids=... or subscribe via WS
 * (trade_results_ws.ts) to know when the order completes.
 */
import { LIVE_CONFIG } from "./config";
import { postJson, getJson } from "./http";
import { appendAuditLog, updateAuditLog } from "./persistence";
import type {
  LiveSwapOrderResponse,
  LiveSwapOrderInfo,
  LiveTradeType,
  LiveOrderState,
} from "./types";

// ---------------------------------------------------------------------------
// Request types
// ---------------------------------------------------------------------------

/** Fee/tip configuration block used in both top-level and pnlCustomConfig. */
export interface FeeConfig {
  /** When true both priorityFee and jitoTip are used as-provided. */
  customFeeAndTip: boolean;
  /** Priority fee in SOL ("" = auto). */
  priorityFee: string;
  /** Extra gas for EVM chains (not used for Solana but required by API). */
  gasFeeDelta: number;
  /** Max gas for EVM (not used for Solana but required by API). */
  maxFeePerGas: number;
  /** Enable Jito anti-MEV. */
  jitoEnabled: boolean;
  /** Jito bribery tip in SOL. */
  jitoTip: number;
  /** Max slippage tolerance (0.00-1.00). */
  maxSlippage: number;
  /** Number of concurrent nodes (1-3). */
  concurrentNodes: number;
  /** Retries after failure (0-10). */
  retries: number;
}

/** A single TP/SL tier: sell amountPercent of position when price moves by pricePercent. */
export interface PnLTier {
  /** Price change fraction (e.g., 0.5 = 50% increase for TP). */
  pricePercent: number;
  /** Fraction of position to sell at this tier (0–1). */
  amountPercent: number;
}

/** Parameters for creating a live swap order. */
export interface LiveSwapOrderParams {
  /** Blockchain — always "solana". */
  chain: string;
  /** Token or pair address to buy/sell. */
  pair: string;
  /** Wallet ID from Wallet Info API. */
  walletId: string;
  /** Trade direction. */
  type: LiveTradeType;
  /**
   * Buy: SOL amount to spend.
   * Sell: ratio of position to sell (0-1).
   */
  amountOrPercent: number;

  /** Fee/tip configuration. */
  customFeeAndTip: boolean;
  priorityFee: string;
  gasFeeDelta: number;
  maxFeePerGas: number;
  jitoEnabled: boolean;
  jitoTip: number;
  maxSlippage: number;
  concurrentNodes: number;
  retries: number;

  /** Opening sell ratio for Pump→Raydium migration (0 = disabled). */
  migrateSellPercent?: number;
  /** Trigger: sell if dev sells more than this ratio (0 = disabled). */
  minDevSellPercent?: number;
  /** Ratio to sell when dev sell triggers (0 = disabled). */
  devSellPercent?: number;

  /** Simple TP ratio (overridden by stopEarnGroup if both set). */
  stopEarnPercent?: number;
  /** Simple SL ratio (overridden by stopLossGroup if both set). */
  stopLossPercent?: number;
  /** Multi-tier TP — up to 6 tiers. */
  stopEarnGroup?: PnLTier[];
  /** Multi-tier SL — up to 6 tiers. */
  stopLossGroup?: PnLTier[];
  /** Trailing stop — only 1 group supported. */
  trailingStopGroup?: {
    /** Drawdown fraction that triggers sell (must be < 1). */
    pricePercent: number;
    /** Sell ratio (0-1). */
    amountPercent: number;
    /** Activation price fraction above entry (e.g., 0.2 = 20%). */
    activePricePercent: number;
  }[];

  /** TP/SL task expiry in ms (max 432_000_000). */
  pnlOrderExpireDelta: number;
  /** Execute market sell on TP/SL expiry. */
  pnlOrderExpireExecute: boolean;
  /** Use 1-second mid-price for anti-spike triggering. */
  pnlOrderUseMidPrice: boolean;

  /** Use custom fee config for TP/SL sells (separate from buy). */
  pnlCustomConfigEnabled: boolean;
  /** Custom fee config for TP/SL sells (only if pnlCustomConfigEnabled). */
  pnlCustomConfig?: FeeConfig;
}

// ---------------------------------------------------------------------------
// Defaults builder
// ---------------------------------------------------------------------------

/**
 * Build a LiveSwapOrderParams with sensible defaults for a BUY.
 *
 * TP/SL is configured server-side via stopEarnGroup / stopLossGroup.
 * The trailing stop and TTL are set here so the server manages them.
 *
 * @param pair      - Token or pair address.
 * @param amountSol - SOL amount to spend.
 * @returns Fully populated swap order params.
 */
export function buildBuyOrderParams(
  pair: string,
  amountSol: number,
): LiveSwapOrderParams {
  /** Determine the backstop TP tier (sell remaining at backstop level). */
  const backstopTier: PnLTier | null = LIVE_CONFIG.backstopTpPct > 0
    ? { pricePercent: LIVE_CONFIG.backstopTpPct, amountPercent: 1 }
    : null;

  /** Build TP tiers: partial tiers from config + optional backstop. */
  const stopEarnGroup: PnLTier[] = [];

  for (const tier of LIVE_CONFIG.partialTpTiers) {
    stopEarnGroup.push({ pricePercent: tier.at, amountPercent: tier.pct });
  }

  if (backstopTier) {
    stopEarnGroup.push(backstopTier);
  }

  /** Build the trailing stop group (client-side equivalent configured server-side too). */
  const trailingStopGroup = LIVE_CONFIG.trailingStopPct > 0
    ? [{
        pricePercent: LIVE_CONFIG.trailingStopPct,
        amountPercent: 1,
        activePricePercent: LIVE_CONFIG.trailingActivationPct,
      }]
    : undefined;

  /** PnL order expire delta in ms — convert from our base TTL. */
  const expireDelta = Math.min(
    LIVE_CONFIG.pnlOrderExpireDeltaMs,
    LIVE_CONFIG.baseTtlSecs * 1000,
  );

  /** Common fee/tip config. */
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
    ...baseFeeConfig,
    migrateSellPercent: LIVE_CONFIG.migrateSellPercent,
    minDevSellPercent: LIVE_CONFIG.minDevSellPercent,
    devSellPercent: LIVE_CONFIG.devSellPercent,
    stopEarnGroup: stopEarnGroup.length > 0 ? stopEarnGroup : undefined,
    stopLossPercent: LIVE_CONFIG.stopLossPct,
    trailingStopGroup,
    pnlOrderExpireDelta: expireDelta,
    pnlOrderExpireExecute: LIVE_CONFIG.pnlOrderExpireExecute,
    pnlOrderUseMidPrice: LIVE_CONFIG.pnlOrderUseMidPrice,
    pnlCustomConfigEnabled: true,
    pnlCustomConfig: baseFeeConfig,
  };
}

/**
 * Build a LiveSwapOrderParams for a SELL (full close).
 *
 * @param pair  - Token or pair address.
 * @returns Fully populated swap order params for a market sell.
 */
export function buildSellOrderParams(
  pair: string,
): LiveSwapOrderParams {
  return {
    chain: "solana",
    pair,
    walletId: LIVE_CONFIG.walletId,
    type: "sell",
    amountOrPercent: 1, // sell 100 %
    customFeeAndTip: LIVE_CONFIG.customFeeAndTip,
    priorityFee: LIVE_CONFIG.priorityFee,
    gasFeeDelta: 5,
    maxFeePerGas: 100,
    jitoEnabled: LIVE_CONFIG.jitoEnabled,
    jitoTip: LIVE_CONFIG.jitoTip,
    maxSlippage: LIVE_CONFIG.maxSlippage,
    concurrentNodes: LIVE_CONFIG.concurrentNodes,
    retries: LIVE_CONFIG.retries,
    pnlOrderExpireDelta: 60_000,
    pnlOrderExpireExecute: true,
    pnlOrderUseMidPrice: false,
    pnlCustomConfigEnabled: false,
  };
}

// ---------------------------------------------------------------------------
// Order creation & status polling
// ---------------------------------------------------------------------------

/**
 * Create a live swap order (buy or sell).
 *
 * @param params - Fully populated swap order parameters.
 * @returns The order ID from the API response.
 * @throws Error if the API rejects the order.
 */
export async function createSwapOrder(
  params: LiveSwapOrderParams,
): Promise<string> {
  const url = `${LIVE_CONFIG.baseUrl}/automation/swap_order`;

  /** Write audit log BEFORE the API call. */
  const auditId = appendAuditLog(
    params.type,
    params.pair,
    params.type === "buy" ? params.amountOrPercent : undefined,
    JSON.stringify(params),
  );

  try {
    /** Disable blind POST retry — a timeout could mean the order was placed. */
    const body = await postJson<LiveSwapOrderResponse>(url, params, {
      retryNonIdempotent: false,
    });

    if (body.err) {
      const errMsg = `Live API rejected ${params.type} order for ${params.pair}`;
      updateAuditLog(auditId, "failed", undefined, JSON.stringify(body), errMsg);
      throw new Error(errMsg);
    }

    if (!body.res?.id) {
      const errMsg = "Live API returned an invalid response (no order ID).";
      updateAuditLog(auditId, "failed", undefined, JSON.stringify(body), errMsg);
      throw new Error(errMsg);
    }

    /** Update audit log with the order ID. */
    updateAuditLog(auditId, "sent", body.res.id, JSON.stringify(body));

    console.info(
      `[live/swap] ${params.type.toUpperCase()} ${params.pair} size=${params.amountOrPercent} SOL -> orderId=${body.res.id}`,
    );

    return body.res.id;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    updateAuditLog(auditId, "error", undefined, undefined, errMsg);
    throw err;
  }
}

/**
 * Convenience: create a live BUY order.
 *
 * @param pair      - Token or pair address.
 * @param amountSol - SOL amount to spend.
 * @returns The order ID.
 */
export async function liveFastBuy(
  pair: string,
  amountSol: number,
): Promise<string> {
  const params = buildBuyOrderParams(pair, amountSol);
  return createSwapOrder(params);
}

/**
 * Convenience: create a live SELL order (full close).
 *
 * @param pair - Token or pair address.
 * @returns The order ID.
 */
export async function liveFastSell(pair: string): Promise<string> {
  const params = buildSellOrderParams(pair);
  return createSwapOrder(params);
}

// ---------------------------------------------------------------------------
// Order status query
// ---------------------------------------------------------------------------

/**
 * Response shape from GET /automation/swap_orders.
 */
interface SwapOrdersResponse {
  err: boolean;
  res: LiveSwapOrderInfo[];
}

/**
 * Query the current state of one or more swap orders.
 *
 * @param orderIds - One or more order IDs to query.
 * @returns Array of order info objects.
 */
export async function querySwapOrders(
  orderIds: string[],
): Promise<LiveSwapOrderInfo[]> {
  if (orderIds.length === 0) return [];

  const idsParam = orderIds.join(",");
  const url = `${LIVE_CONFIG.baseUrl}/automation/swap_orders?ids=${encodeURIComponent(idsParam)}`;

  const body = await getJson<SwapOrdersResponse>(url);

  if (body.err) throw new Error("Swap orders API returned err: true");

  return body.res;
}

/**
 * Query a single swap order by ID.
 *
 * @param orderId - The order ID.
 * @returns Order info, or null if not found.
 */
export async function querySwapOrder(
  orderId: string,
): Promise<LiveSwapOrderInfo | null> {
  const orders = await querySwapOrders([orderId]);
  return orders[0] ?? null;
}

/**
 * Poll a swap order until it reaches a terminal state (done / fail / expired).
 *
 * @param orderId - The order ID to poll.
 * @param maxAttempts - Maximum number of poll attempts.
 * @param intervalMs - Delay between polls in ms.
 * @returns The final order info.
 * @throws Error if the order times out or fails.
 */
export async function pollSwapOrderUntilDone(
  orderId: string,
  maxAttempts: number = LIVE_CONFIG.maxSwapOrderPollAttempts,
  intervalMs: number = LIVE_CONFIG.swapOrderPollMs,
): Promise<LiveSwapOrderInfo> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const order = await querySwapOrder(orderId);

    if (!order) {
      console.warn(`[live/swap] Order ${orderId} not found yet (attempt ${attempt})`);
      await sleep(intervalMs);
      continue;
    }

    if (order.state === "done") {
      return order;
    }

    if (order.state === "fail" || order.state === "expired") {
      throw new Error(
        `Order ${orderId} ${order.state}: ${order.errorMessage ?? "no error message"}`,
      );
    }

    /** Still processing — wait and retry. */
    await sleep(intervalMs);
  }

  throw new Error(`Order ${orderId} did not complete within ${maxAttempts} polls`);
}

/** Sleep helper. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
