import type { Position, PositionExitReason } from "../types";

export interface ExitCheckResult {
  position: Position;
  reason: PositionExitReason;
  percentage?: number;
}

export interface ExitStrategy {
  readonly name: string;
  check(position: Position, now: number): ExitCheckResult | null;
}
