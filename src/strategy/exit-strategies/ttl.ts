import type { Position } from "../types";
import { PositionExitReason } from "../types";
import type { ExitCheckResult, ExitStrategy } from "./types";

export class TtlStrategy implements ExitStrategy {
  readonly name = "ttl";

  constructor(
    private readonly baseTtlSecs: number,
    private readonly maxTtlSecs: number,
    private readonly minProfitForExtensionPct: number,
  ) {}

  check(position: Position, now: number): ExitCheckResult | null {
    const ageSeconds = (now - position.openedAt) / 1000;

    if (ageSeconds < this.baseTtlSecs) {
      return null;
    }

    const profitable =
      position.currentProfitPct >= this.minProfitForExtensionPct;

    if (profitable && ageSeconds < this.maxTtlSecs) {
      return null;
    }

    return { position, reason: PositionExitReason.Expired };
  }
}
