import type { PartialTpTier } from "../../config";

import { ExitAction, type ExitDecision, type ExitStrategy } from "./types";

import { PositionExitReason, type Position } from "../types";

// ============================================================================
// Partial Take Profit Strategy
// ============================================================================

/**
 * Gradually reduces a position as predefined profit targets are reached.
 *
 * Example:
 *
 * Tier 1
 *  +30% → Sell 25%
 *
 * Tier 2
 *  +60% → Sell 25%
 *
 * Tier 3
 * +100% → Sell 50%
 *
 * The strategy never modifies the position directly. Instead it returns
 * an ExitDecision containing the next tier index to be applied by the
 * Position Engine.
 */
export class PartialTakeProfitStrategy implements ExitStrategy {
  readonly name = "partial_tp";

  constructor(
    private readonly enabled: boolean,
    private readonly tiers: readonly PartialTpTier[],
  ) {}

  /**
   * Calculates all take-profit tiers reached by the current profit.
   *
   * Returns:
   *
   * • total percentage to sell
   * • next tier index
   */
  private calculateTriggeredTiers(position: Position): {
    percentage: number;
    nextTier: number;
  } {
    let percentage = 0;

    let nextTier = position.partialTierIndex;

    while (nextTier < this.tiers.length) {
      const tier = this.tiers[nextTier];

      if (!tier || position.currentProfitPct < tier.at) {
        break;
      }

      percentage += tier.pct;

      nextTier++;
    }

    return {
      percentage,
      nextTier,
    };
  }

  /**
   * Evaluates the position against the configured take-profit tiers.
   *
   * Returns a partial sell request when one or more new tiers have been
   * reached since the last evaluation.
   */
  check(position: Position, _now: number): ExitDecision | null {
    // -----------------------------------------------------------------------
    // Strategy disabled.
    // -----------------------------------------------------------------------

    if (!this.enabled) {
      return null;
    }

    // -----------------------------------------------------------------------
    // Ignore invalid profit values.
    // -----------------------------------------------------------------------

    if (!Number.isFinite(position.currentProfitPct)) {
      return null;
    }

    // -----------------------------------------------------------------------
    // Calculate newly triggered tiers.
    // -----------------------------------------------------------------------

    const { percentage, nextTier } = this.calculateTriggeredTiers(position);

    if (percentage <= 0) {
      return null;
    }

    // -----------------------------------------------------------------------
    // Request a partial position exit.
    //
    // The Position Engine will:
    //   1. Execute the sell.
    //   2. Apply the returned patch.
    // -----------------------------------------------------------------------

    return {
      position,

      action: ExitAction.PartialSell,

      reason: PositionExitReason.PartialTakeProfit,

      percentage: Math.min(percentage, 1),

      patch: {
        partialTierIndex: nextTier,
      },

      metadata: {
        currentProfit: position.currentProfitPct,

        previousTier: position.partialTierIndex,

        nextTier,

        tiersTriggered: nextTier - position.partialTierIndex,

        sellPercentage: percentage,
      },
    };
  }
}
