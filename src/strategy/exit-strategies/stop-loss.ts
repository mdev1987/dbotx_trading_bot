import { ExitAction, type ExitDecision, type ExitStrategy } from "./types";

import { PositionExitReason, type Position } from "../types";

// ============================================================================
// Stop Loss Strategy
// ============================================================================

/**
 * Closes a position once its unrealized loss reaches the configured limit.
 *
 * Example:
 *
 * Entry Price:      1.00
 * Stop Loss:      -15%
 *
 * Price falls to 0.85
 *
 * → Strategy requests a full position close.
 */
export class StopLossStrategy implements ExitStrategy {
  readonly name = "stop_loss";

  constructor(
    private readonly enabled: boolean,
    private readonly stopLossPct: number,
  ) {}

  /**
   * Evaluates the current position.
   *
   * Returns null when no action is required.
   */
  check(position: Position, _now: number): ExitDecision | null {
    if (!this.enabled) {
      return null;
    }

    if (!Number.isFinite(position.currentProfitPct)) {
      return null;
    }

    if (position.currentProfitPct > this.stopLossPct) {
      return null;
    }

    return {
      position,

      action: ExitAction.Close,

      reason: PositionExitReason.StopLoss,

      metadata: {
        profitPct: position.currentProfitPct,

        threshold: this.stopLossPct,
      },
    };
  }
}
