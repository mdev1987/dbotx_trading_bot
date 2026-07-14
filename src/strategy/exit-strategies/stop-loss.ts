import type { Position } from "../types";
import { PositionExitReason } from "../types";
import type { ExitCheckResult, ExitStrategy } from "./types";

export class StopLossStrategy implements ExitStrategy {
  readonly name = "stop_loss";

  constructor(
    private readonly enabled: boolean,
    private readonly stopLossPct: number,
  ) {}

  check(position: Position, _now: number): ExitCheckResult | null {
    if (!this.enabled) {
      return null;
    }

    if (!Number.isFinite(position.currentProfitPct)) {
      return null;
    }

    if (position.currentProfitPct > this.stopLossPct) {
      return null;
    }

    return { position, reason: PositionExitReason.StopLoss };
  }
}
