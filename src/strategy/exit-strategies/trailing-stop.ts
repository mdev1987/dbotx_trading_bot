import type { Position } from "../types";
import { PositionExitReason } from "../types";
import type { ExitCheckResult, ExitStrategy } from "./types";

export class TrailingStopStrategy implements ExitStrategy {
  readonly name = "trailing_stop";

  constructor(
    private readonly activationPct: number,
    private readonly distancePct: number,
  ) {}

  check(position: Position, _now: number): ExitCheckResult | null {
    const entry = position.entryPrice;
    if (!Number.isFinite(entry) || entry <= 0) return null;

    if (!Number.isFinite(position.currentProfitPct)) return null;
    if (!Number.isFinite(position.peakPrice) || position.peakPrice <= 0)
      return null;

    const peakProfit = (position.peakPrice - entry) / entry;

    if (peakProfit < this.activationPct) {
      return null;
    }

    const drawdown = peakProfit - position.currentProfitPct;

    if (drawdown < this.distancePct) {
      return null;
    }

    return { position, reason: PositionExitReason.TrailingStop };
  }
}
