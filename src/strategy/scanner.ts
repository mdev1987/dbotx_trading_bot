import { Subject } from "rxjs";

import { positions } from "./positions_store";
import type { ExitCheckResult, ExitStrategy } from "./exit-strategies/types";

const pendingExitIds = new Set<string>();

export const positionExitRequested$ = new Subject<ExitCheckResult>();

export function registerStrategies(strategies: ExitStrategy[]): void {
  for (const strategy of strategies) {
    registeredStrategies.push(strategy);
  }
}

const registeredStrategies: ExitStrategy[] = [];

export function clearPendingExit(positionId: string): void {
  pendingExitIds.delete(positionId);
}

export function scanPositions(now: number): void {
  for (const strategy of registeredStrategies) {
    for (const position of positions.values()) {
      if (position.status !== "open") {
        continue;
      }

      if (position.entryPriceUsd <= 0) {
        continue;
      }

      if (pendingExitIds.has(position.id)) {
        continue;
      }

      const result = strategy.check(position, now);

      if (result) {
        pendingExitIds.add(position.id);
        positionExitRequested$.next(result);
      }
    }
  }
}
