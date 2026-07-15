import { ExitAction, type ExitDecision, type ExitStrategy } from "./types";

import { PositionExitReason, type Position } from "../types";

// ============================================================================
// Trailing Stop Strategy
// ============================================================================

/**
 * Protects unrealized profit after a position has moved sufficiently
 * into profit.
 *
 * Example:
 *
 * Entry Price:      1.00
 * Activation:     +30%
 * Trail:            10%
 *
 * Price:
 *
 * 1.00
 * 1.20
 * 1.35   ← Trailing stop becomes active
 * 1.50   ← New peak
 * 1.44
 * 1.38   ← Drawdown exceeds trail distance
 *
 * → Request full position close.
 */
export class TrailingStopStrategy implements ExitStrategy {
  readonly name = "trailing_stop";

  constructor(
    private readonly activationPct: number,
    private readonly trailDistancePct: number,
  ) {}

  /**
   * Calculates the maximum unrealized profit reached.
   */
  private calculatePeakProfit(position: Position): number {
    return (position.peakPrice - position.entryPrice) / position.entryPrice;
  }

  /**
   * Calculates the drawdown from the highest unrealized profit.
   */
  private calculateDrawdown(peakProfit: number, currentProfit: number): number {
    return peakProfit - currentProfit;
  }

  /**
   * Evaluates the position.
   *
   * Returns a close request once the trailing stop has been activated
   * and the drawdown exceeds the configured trail distance.
   */
  check(position: Position, _now: number): ExitDecision | null {
    // -----------------------------------------------------------------------
    // Validate required values.
    // -----------------------------------------------------------------------

    if (!Number.isFinite(position.entryPrice) || position.entryPrice <= 0) {
      return null;
    }

    if (!Number.isFinite(position.peakPrice) || position.peakPrice <= 0) {
      return null;
    }

    if (!Number.isFinite(position.currentProfitPct)) {
      return null;
    }

    // -----------------------------------------------------------------------
    // Calculate peak profit and current drawdown.
    // -----------------------------------------------------------------------

    const peakProfit = this.calculatePeakProfit(position);

    // Strategy is not active yet.
    if (peakProfit < this.activationPct) {
      return null;
    }

    const drawdown = this.calculateDrawdown(
      peakProfit,
      position.currentProfitPct,
    );

    // Drawdown is still within the allowed distance.
    if (drawdown < this.trailDistancePct) {
      return null;
    }

    // -----------------------------------------------------------------------
    // Request a full position exit.
    // -----------------------------------------------------------------------

    return {
      position,

      action: ExitAction.Close,

      reason: PositionExitReason.TrailingStop,

      metadata: {
        entryPrice: position.entryPrice,

        peakPrice: position.peakPrice,

        currentPrice: position.currentPrice,

        peakProfit,

        currentProfit: position.currentProfitPct,

        drawdown,

        activation: this.activationPct,

        trailDistance: this.trailDistancePct,
      },
    };
  }
}
