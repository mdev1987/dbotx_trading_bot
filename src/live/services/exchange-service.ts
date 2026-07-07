import { LIVE_CONFIG } from "../config";
import { postJson, getJson } from "../http";
import type { IExchangeService } from "../../core/interfaces";
import type { ParsedSignal } from "../../telegram/telegram_listener";
import type {
  LiveSwapOrderResponse,
  LiveSwapOrderInfo,
} from "../types";
import { appendAuditLog, updateAuditLog } from "../persistence";

interface FeeConfig {
  customFeeAndTip: boolean;
  priorityFee: string;
  gasFeeDelta: number;
  maxFeePerGas: number;
  jitoEnabled: boolean;
  jitoTip: number;
  maxSlippage: number;
  concurrentNodes: number;
  retries: number;
}

export interface PnLTier {
  pricePercent: number;
  amountPercent: number;
}

export interface LiveSwapOrderParams {
  chain: string;
  pair: string;
  walletId: string;
  type: "buy" | "sell";
  amountOrPercent: number;
  customFeeAndTip: boolean;
  priorityFee: string;
  gasFeeDelta: number;
  maxFeePerGas: number;
  jitoEnabled: boolean;
  jitoTip: number;
  maxSlippage: number;
  concurrentNodes: number;
  retries: number;
  migrateSellPercent?: number;
  minDevSellPercent?: number;
  devSellPercent?: number;
  stopEarnPercent?: number;
  stopLossPercent?: number;
  stopEarnGroup?: PnLTier[];
  stopLossGroup?: PnLTier[];
  trailingStopGroup?: { pricePercent: number; amountPercent: number; activePricePercent: number }[];
  pnlOrderExpireDelta: number;
  pnlOrderExpireExecute: boolean;
  pnlOrderUseMidPrice: boolean;
  pnlCustomConfigEnabled: boolean;
  pnlCustomConfig?: FeeConfig;
}

export class LiveExchangeService implements IExchangeService {
  async buy(pair: string, amountSol: number, signal?: ParsedSignal): Promise<string> {
    const params = this.buildBuyParams(pair, amountSol, signal);
    return this.createOrder(params);
  }

  async sell(pair: string): Promise<string> {
    const params = this.buildSellParams(pair);
    return this.createOrder(params);
  }

  async queryOrder(orderId: string): Promise<{ state: string; txPriceUsd?: number } | null> {
    const orders = await this.queryOrders([orderId]);
    return orders[0] ?? null;
  }

  async queryOrders(orderIds: string[]): Promise<{ id: string; state: string; txPriceUsd?: number }[]> {
    if (orderIds.length === 0) return [];
    const idsParam = orderIds.join(",");
    const url = `${LIVE_CONFIG.baseUrl}/automation/swap_orders?ids=${encodeURIComponent(idsParam)}`;
    interface SwapOrdersResponse {
      err: boolean;
      res: LiveSwapOrderInfo[];
    }
    const body = await getJson<SwapOrdersResponse>(url);
    if (body.err) throw new Error("Swap orders API returned err: true");
    return body.res;
  }

  async pollUntilDone(
    orderId: string,
    maxAttempts: number = LIVE_CONFIG.maxSwapOrderPollAttempts,
    intervalMs: number = LIVE_CONFIG.swapOrderPollMs,
  ): Promise<{ txPriceUsd?: number }> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const order = await this.queryOrder(orderId);
      if (!order) {
        await this.sleep(intervalMs);
        continue;
      }
      if (order.state === "done") return order;
      if (order.state === "fail" || order.state === "expired") {
        throw new Error(`Order ${orderId} ${order.state}`);
      }
      await this.sleep(intervalMs);
    }
    throw new Error(`Order ${orderId} did not complete within ${maxAttempts} polls`);
  }

  private async createOrder(params: LiveSwapOrderParams): Promise<string> {
    const url = `${LIVE_CONFIG.baseUrl}/automation/swap_order`;
    const auditId = appendAuditLog(
      params.type,
      params.pair,
      params.type === "buy" ? params.amountOrPercent : undefined,
      JSON.stringify(params),
    );

    try {
      const body = await postJson<LiveSwapOrderResponse>(url, params, { retryNonIdempotent: false });
      if (body.err || !body.res?.id) {
        const errMsg = body.err
          ? `Live API rejected ${params.type} order for ${params.pair}`
          : "Live API returned invalid response (no order ID)";
        updateAuditLog(auditId, "failed", undefined, JSON.stringify(body), errMsg);
        throw new Error(errMsg);
      }
      updateAuditLog(auditId, "sent", body.res.id, JSON.stringify(body));
      return body.res.id;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      updateAuditLog(auditId, "error", undefined, undefined, errMsg);
      throw err;
    }
  }

  private buildBuyParams(pair: string, amountSol: number, signal?: ParsedSignal): LiveSwapOrderParams {
    const { partialTpEnabled, partialTpTiers, backstopTpPct } = LIVE_CONFIG;
    const stopEarnGroup: PnLTier[] = [];

    if (partialTpEnabled) {
      for (const tier of partialTpTiers) {
        stopEarnGroup.push({ pricePercent: tier.at, amountPercent: tier.pct });
      }
      const maxPumpX = (signal as { maxPumpX?: number })?.maxPumpX;
      const effectiveBackstop = maxPumpX && maxPumpX > 0 ? (maxPumpX - 1) * 0.7 : backstopTpPct;
      if (effectiveBackstop > 0) {
        const soldSoFar = partialTpTiers.reduce((sum, t) => sum + t.pct, 0);
        const remaining = 1 - soldSoFar;
        if (remaining > 0.001) {
          stopEarnGroup.push({ pricePercent: effectiveBackstop, amountPercent: remaining });
        }
      }
    } else if (backstopTpPct > 0) {
      stopEarnGroup.push({ pricePercent: backstopTpPct, amountPercent: 1 });
    }

    const trailingStopGroup = LIVE_CONFIG.trailingStopPct > 0
      ? [{ pricePercent: LIVE_CONFIG.trailingStopPct, amountPercent: 1, activePricePercent: LIVE_CONFIG.trailingActivationPct }]
      : undefined;

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

  private buildSellParams(pair: string): LiveSwapOrderParams {
    return {
      chain: "solana",
      pair,
      walletId: LIVE_CONFIG.walletId,
      type: "sell",
      amountOrPercent: 1,
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

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
