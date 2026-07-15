import type { PriceCurrency, PriceSource } from "../data_stream/types";

// ============================================================================
// Exit Actions
// ============================================================================

/**
 * Action requested by a strategy.
 *
 * A strategy never executes trades or mutates a position directly.
 * Instead it returns one of these actions, allowing the Position Engine
 * to decide how and when to apply the requested change.
 */
export enum ExitAction {
  /** Keep monitoring the position. */
  Hold = "hold",

  /** Sell part of the position. */
  PartialSell = "partial_sell",

  /** Sell the entire position. */
  Close = "close",

  /** Renew the TTL timer. */
  Renew = "renew",
}

// ============================================================================
// Position Updates
// ============================================================================

/**
 * Optional state updates requested by a strategy.
 *
 * These changes are applied by the Position Engine after the strategy
 * has been evaluated.
 */
export interface PositionPatch {
  partialTierIndex?: number;

  renewedAt?: number;

  renewPrice?: number;

  peakPrice?: number;
}

// ============================================================================
// Strategy Decision
// ============================================================================

/**
 * Result returned from an exit strategy.
 *
 * Returning `null` means the strategy has no opinion and the next strategy
 * may continue evaluating the position.
 */
export interface ExitDecision {
  /** Position being evaluated. */
  readonly position: Position;

  /** Action requested by the strategy. */
  readonly action: ExitAction;

  /** Why this action was requested. */
  readonly reason: PositionExitReason;

  /** Percentage of the position to close. */
  readonly percentage?: number;

  /** Optional state updates. */
  readonly patch?: PositionPatch;

  /** Extra information useful for logging/debugging. */
  readonly metadata?: Record<string, unknown>;
}

// ============================================================================
// Position Exit Reason
// ============================================================================

/**
 * Reason why a position was fully or partially closed.
 */
export enum PositionExitReason {
  StopLoss = "stop_loss",

  TrailingStop = "trailing_stop",

  PartialTakeProfit = "partial_take_profit",

  TakeProfit = "take_profit",

  Expired = "expired",

  Manual = "manual",
}

// ============================================================================
// Position
// ============================================================================

export interface Position {
  // -------------------------------------------------------------------------
  // Identity
  // -------------------------------------------------------------------------

  readonly id: string;

  readonly pair: string;

  readonly token: string;

  readonly tokenName: string;

  // -------------------------------------------------------------------------
  // Entry
  // -------------------------------------------------------------------------

  entryPrice: number;

  sizeSol: number;

  sizeToken: number;

  openedAt: number;

  // -------------------------------------------------------------------------
  // Live Market Data
  // -------------------------------------------------------------------------

  currentPrice: number;

  peakPrice: number;

  currentProfitPct: number;

  lastPriceTimestamp: number;

  lastUpdateAt: number;

  priceSource?: PriceSource;

  priceCurrency: PriceCurrency;

  // -------------------------------------------------------------------------
  // Position State
  // -------------------------------------------------------------------------

  status: "open" | "closed";

  soldPct: number;

  partialTierIndex: number;

  // -------------------------------------------------------------------------
  // TTL
  // -------------------------------------------------------------------------

  renewedAt: number;

  renewPrice: number;

  // -------------------------------------------------------------------------
  // Close Information
  // -------------------------------------------------------------------------

  reason?: PositionExitReason;

  closePrice?: number;

  closedAt?: number;

  // -------------------------------------------------------------------------
  // Signal Metadata
  // -------------------------------------------------------------------------

  signalMeta?: {
    marketCapUSD?: number;
    dex?: string;
  };
}
