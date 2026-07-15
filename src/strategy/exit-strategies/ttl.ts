import type { Position } from "../types";
import { PositionExitReason } from "../types";
import type { ExitCheckResult, ExitStrategy } from "./types";

export class TtlStrategy implements ExitStrategy {
  readonly name = "ttl";

  constructor(
    private readonly baseTtlSecs: number,
    private readonly maxTtlSecs: number,
    private readonly profitPercentChange: number,
  ) {}

  check(position: Position, now: number): ExitCheckResult | null {
    const ageSinceRenew = (now - position.renewedAt) / 1000;

    if (ageSinceRenew < this.baseTtlSecs) {
      return null;
    }

    const totalAge = (now - position.openedAt) / 1000;

    if (totalAge >= this.maxTtlSecs) {
      return { position, reason: PositionExitReason.Expired };
    }

    const priceChange = Math.abs(
      (position.currentPrice - position.renewPrice) / position.renewPrice,
    );

    if (priceChange >= this.profitPercentChange) {
      position.renewedAt = now;
      position.renewPrice = position.currentPrice;
      return null;
    }

    return { position, reason: PositionExitReason.Expired };
  }
}
