import { CONFIG } from "../../config";
import { fetchWithRetry } from "../http";
import type { IExchangeService } from "../../core/interfaces";
import type { ParsedSignal } from "../../telegram/telegram_listener";

export interface ProfitLossGroup {
  pricePercent: number;
  amountPercent: number;
}

export interface SimulatorFastSwapRequest {
  chain?: "solana";
  pair: string;
  walletId?: string;
  type: "buy" | "sell";
  amountOrPercent: number;
  stopEarnPercent?: number;
  stopLossPercent?: number;
  stopEarnGroup?: ProfitLossGroup[];
  stopLossGroup?: ProfitLossGroup[];
  priorityFee?: number | "";
  gasFeeDelta?: number;
  maxFeePerGas?: number;
  slippage?: number;
}

interface SimulatorOrderResponse {
  err: boolean;
  res: { id: string };
  docs?: string;
}

export class SimulatorExchangeService implements IExchangeService {
  private readonly endpoint = "/simulator/sim_swap_order";

  async buy(pair: string, amountSol: number, signal?: ParsedSignal): Promise<string> {
    return this.createOrder({
      pair,
      amountOrPercent: amountSol,
      type: "buy",
    });
  }

  async sell(pair: string): Promise<string> {
    return this.createOrder({
      pair,
      amountOrPercent: 1,
      type: "sell",
    });
  }

  async queryOrder(orderId: string): Promise<{ state: string; txPriceUsd?: number } | null> {
    return null;
  }

  async queryOrders(orderIds: string[]): Promise<{ id: string; state: string; txPriceUsd?: number }[]> {
    return [];
  }

  async createOrder(request: Omit<SimulatorFastSwapRequest, "chain" | "walletId" | "priorityFee" | "gasFeeDelta" | "maxFeePerGas" | "slippage">): Promise<string> {
    const payload: SimulatorFastSwapRequest = {
      chain: "solana",
      walletId: "",
      priorityFee: "",
      gasFeeDelta: CONFIG.defaultGasFeeDelta,
      maxFeePerGas: CONFIG.defaultMaxFeePerGas,
      slippage: CONFIG.defaultSlippage,
      ...request,
    };

    const response = await fetchWithRetry(
      `${CONFIG.baseUrl}${this.endpoint}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": CONFIG.dbotxApiKey!,
        },
        body: JSON.stringify(payload),
      },
    );

    const json = (await response.json()) as SimulatorOrderResponse;
    if (json.err || !json.res?.id) {
      throw new Error(`Simulator rejected ${request.type} order for ${request.pair}`);
    }
    return json.res.id;
  }
}
