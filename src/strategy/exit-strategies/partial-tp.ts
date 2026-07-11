import type { PartialTpTier } from "../../config";
import type { Position } from "../types";
import { PositionExitReason } from "../types";
import type { ExitCheckResult, ExitStrategy } from "./types";

export class PartialTakeProfitStrategy implements ExitStrategy {
  readonly name = "partial_tp";

  constructor(
    private readonly enabled: boolean,
    private readonly tiers: PartialTpTier[],
  ) {}

  check(position: Position, _now: number): ExitCheckResult | null {
    if (!this.enabled) {
      return null;
    }

    while (position.partialTierIndex < this.tiers.length) {
      const tier = this.tiers[position.partialTierIndex];

      if (!tier || position.currentProfitPct < tier.at) {
        break;
      }

      position.partialTierIndex++;

      return {
        position,
        reason: PositionExitReason.PartialTP,
        percentage: tier.pct,
      };
    }

    return null;
  }
}
