import { CONFIG } from "../../config";
import { fetchWithRetry } from "../http";
import type { IExchangeService } from "../../core/interfaces";
import type { ParsedSignal } from "../../telegram/telegram_listener";

/** A single take-profit or stop-loss tier for simulator orders */
export interface ProfitLossGroup {
  pricePercent: number;  // Price change percentage threshold
  amountPercent: number; // Fraction (0-1) of the position to allocate
}

/** Parameters for a fast swap order through the simulator API */
export interface SimulatorFastSwapRequest {
  chain?: "solana";                      // Blockchain (defaults to solana)
  pair: string;                           // Trading pair symbol
  walletId?: string;                      // Wallet ID (optional for simulator)
  type: "buy" | "sell";                   // Order direction
  amountOrPercent: number;                // Amount in SOL or percentage
  stopEarnPercent?: number;               // Take-profit percentage
  stopLossPercent?: number;               // Stop-loss percentage
  stopEarnGroup?: ProfitLossGroup[];      // Multi-tier take-profit targets
  stopLossGroup?: ProfitLossGroup[];      // Multi-tier stop-loss targets
  priorityFee?: number | "";              // Priority fee (empty string means auto)
  gasFeeDelta?: number;                   // Gas fee delta
  maxFeePerGas?: number;                  // Max fee per gas unit
  slippage?: number;                      // Allowed slippage percentage
}

/** Shape of the response from the simulator's swap order endpoint */
interface SimulatorOrderResponse {
  err: boolean;          // Whether the API returned an error
  res: { id: string };   // The created order ID
  docs?: string;         // Optional documentation URL
}

/** Service for executing swap orders against the simulator API (paper trading) */
export class SimulatorExchangeService implements IExchangeService {
  private readonly endpoint = "/simulator/sim_swap_order"; // Simulator API path

  /**
   * Place a simulated buy order
   * @param pair - Trading pair symbol
   * @param amountSol - Amount of SOL to spend
   * @param signal - Optional signal (not used in simulator)
   * @returns The simulated order ID
   */
  async buy(pair: string, amountSol: number, signal?: ParsedSignal): Promise<string> {
    return this.createOrder({
      pair,
      amountOrPercent: amountSol,
      type: "buy",
    });
  }

  /**
   * Place a simulated sell order (sells entire position)
   * @param pair - Trading pair symbol
   * @returns The simulated order ID
   */
  async sell(pair: string): Promise<string> {
    return this.createOrder({
      pair,
      amountOrPercent: 1, // Sell full position
      type: "sell",
    });
  }

  /** Simulator does not support live order queries — always returns null */
  async queryOrder(orderId: string): Promise<{ state: string; txPriceUsd?: number } | null> {
    return null;
  }

  /** Simulator does not support batch order queries — always returns empty array */
  async queryOrders(orderIds: string[]): Promise<{ id: string; state: string; txPriceUsd?: number }[]> {
    return [];
  }

  /**
   * Send a swap order request to the simulator API
   * @param request - Partial swap request (chain/wallet/fee defaults are filled in)
   * @returns The order ID from the simulator
   */
  async createOrder(request: Omit<SimulatorFastSwapRequest, "chain" | "walletId" | "priorityFee" | "gasFeeDelta" | "maxFeePerGas" | "slippage">): Promise<string> {
    // Merge defaults with the provided request to form the full payload
    const payload: SimulatorFastSwapRequest = {
      chain: "solana",
      walletId: "",
      priorityFee: "",
      gasFeeDelta: CONFIG.defaultGasFeeDelta,
      maxFeePerGas: CONFIG.defaultMaxFeePerGas,
      slippage: CONFIG.defaultSlippage,
      ...request,
    };

    // POST the payload to the simulator endpoint with retry logic
    const response = await fetchWithRetry(
      `${CONFIG.baseUrl}${this.endpoint}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": CONFIG.dbotxApiKey!, // API key for authentication
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
