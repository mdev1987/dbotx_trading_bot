import { ExitAction, type ExitDecision, type ExitStrategy } from "./types";

import { PositionExitReason, type Position } from "../types";

// ============================================================================
// Time-To-Live (TTL) Strategy
// ============================================================================

/**
 * Limits how long a position may remain open.
 *
 * A position is periodically renewed when its price changes by a configured
 * percentage. If no meaningful movement occurs before the base TTL expires,
 * the position is closed.
 *
 * Regardless of renewals, the position is always closed once the maximum TTL
 * is reached.
 */
export class TtlStrategy implements ExitStrategy {
  readonly name = "ttl";

  constructor(
    private readonly baseTtlSecs: number,
    private readonly maxTtlSecs: number,
    private readonly renewThresholdPct: number,
  ) {}

  /**
   * Returns the number of seconds since the last renewal.
   */
  private ageSinceRenew(position: Position, now: number): number {
    return (now - position.renewedAt) / 1000;
  }

  /**
   * Returns the total lifetime of the position.
   */
  private totalAge(position: Position, now: number): number {
    return (now - position.openedAt) / 1000;
  }

  /**
   * Calculates the absolute price change since the last renewal.
   */
  private renewalPriceChange(position: Position): number {
    if (!Number.isFinite(position.renewPrice) || position.renewPrice <= 0) {
      return 0;
    }

    return Math.abs(
      (position.currentPrice - position.renewPrice) / position.renewPrice,
    );
  }

  /**
   * Evaluates the position lifetime.
   *
   * Possible outcomes:
   *
   * • Hold   → Continue monitoring.
   * • Renew  → Extend the TTL window.
   * • Close  → Position has expired.
   */
  check(position: Position, now: number): ExitDecision | null {
    // -----------------------------------------------------------------------
    // Skip positions that never received a price.
    //
    // This prevents premature expiry before the WebSocket price stream
    // initializes the position. The hard maxTtlSecs cap still applies to
    // avoid zombie positions when the stream is permanently down.
    // -----------------------------------------------------------------------

    if (position.entryPrice <= 0) {
      const totalAge = this.totalAge(position, now);
      if (totalAge < this.maxTtlSecs) {
        return null;
      }
      return {
        position,
        action: ExitAction.Close,
        reason: PositionExitReason.Expired,
        metadata: { totalAge, maxTtl: this.maxTtlSecs },
      };
    }

    // -----------------------------------------------------------------------
    // Wait until the base TTL has elapsed.
    // -----------------------------------------------------------------------

    const renewAge = this.ageSinceRenew(position, now);

    if (renewAge < this.baseTtlSecs) {
      return null;
    }

    // -----------------------------------------------------------------------
    // Hard expiration.
    //
    // Maximum lifetime reached regardless of renewals.
    // -----------------------------------------------------------------------

    const totalAge = this.totalAge(position, now);

    if (totalAge >= this.maxTtlSecs) {
      return {
        position,

        action: ExitAction.Close,

        reason: PositionExitReason.Expired,

        metadata: {
          totalAge,
          maxTtl: this.maxTtlSecs,
        },
      };
    }

    // -----------------------------------------------------------------------
    // Check whether the position has moved enough to renew.
    // -----------------------------------------------------------------------

    const priceChange = this.renewalPriceChange(position);

    if (priceChange >= this.renewThresholdPct) {
      return {
        position,

        action: ExitAction.Renew,

        reason: PositionExitReason.Manual,

        patch: {
          renewedAt: now,

          renewPrice: position.currentPrice,
        },

        metadata: {
          renewAge,

          priceChange,

          threshold: this.renewThresholdPct,
        },
      };
    }

    // -----------------------------------------------------------------------
    // No renewal occurred before the TTL expired.
    // -----------------------------------------------------------------------

    return {
      position,

      action: ExitAction.Close,

      reason: PositionExitReason.Expired,

      metadata: {
        renewAge,

        priceChange,

        threshold: this.renewThresholdPct,
      },
    };
  }
}
