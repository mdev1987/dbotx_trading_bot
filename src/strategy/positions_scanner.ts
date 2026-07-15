import { BehaviorSubject, Subject } from "rxjs";

import { getPositions } from "./positions_store";

import type { Position } from "./types";
import type { ExitDecision, ExitStrategy } from "./exit-strategies/types";

// ============================================================================
// Strategy Registry
// ============================================================================

/**
 * Registered exit strategies.
 *
 * Strategies are evaluated in registration order.
 */
const strategies: ExitStrategy[] = [];

/**
 * Position IDs currently waiting for execution.
 *
 * Prevents multiple sell requests being emitted before the trading engine
 * has processed the first one.
 */
const pendingExitIds = new Set<string>();

// ============================================================================
// Reactive Events
// ============================================================================

/**
 * Emits every exit decision produced by the strategy engine.
 */
export const exitDecision$ = new Subject<ExitDecision>();

/**
 * Emits the currently registered strategy list.
 *
 * Mainly useful for dashboards and debugging.
 */
export const registeredStrategies$ = new BehaviorSubject<
  readonly ExitStrategy[]
>([]);

// ============================================================================
// Strategy Registration
// ============================================================================

/**
 * Registers one or more exit strategies.
 */
export function registerStrategies(...items: ExitStrategy[]): void {
  if (items.length === 0) {
    return;
  }

  strategies.push(...items);

  registeredStrategies$.next([...strategies]);
}

/**
 * Removes every registered strategy.
 *
 * Useful for tests.
 */
export function clearStrategies(): void {
  strategies.length = 0;

  registeredStrategies$.next([]);
}

// ============================================================================
// Pending Exit Management
// ============================================================================

/**
 * Returns true if the position already has a pending exit.
 */
function isPending(positionId: string): boolean {
  return pendingExitIds.has(positionId);
}

/**
 * Marks a position as waiting for execution.
 */
function markPending(positionId: string): void {
  pendingExitIds.add(positionId);
}

/**
 * Clears the pending flag after an order completes.
 */
export function clearPendingExit(positionId: string): void {
  pendingExitIds.delete(positionId);
}

// ============================================================================
// Strategy Evaluation
// ============================================================================

/**
 * Evaluates a single position against all registered strategies.
 *
 * Strategies are executed in registration order. The first strategy that
 * produces a decision wins, preventing conflicting exit requests.
 */
function evaluatePosition(
  position: Position,
  now: number,
): ExitDecision | null {
  // Ignore positions that cannot be traded.
  // Skip closed positions and positions already awaiting exit execution.
  // Positions without a price (entryPrice <= 0) are NOT skipped — TTL can
  // still expire them, preventing zombie positions when the WebSocket is down.
  if (position.status !== "open" || isPending(position.id)) {
    return null;
  }

  for (const strategy of strategies) {
    const decision = strategy.check(position, now);

    if (decision) {
      return decision;
    }
  }

  return null;
}

/**
 * Publishes an exit decision.
 */
function publishDecision(decision: ExitDecision): void {
  markPending(decision.position.id);

  exitDecision$.next(decision);
}

// ============================================================================
// Scanner
// ============================================================================

/**
 * Scans every open position.
 *
 * This function is normally called periodically by the PositionEngine.
 */
export function scanPositions(now = Date.now()): void {
  for (const position of getPositions().values()) {
    const decision = evaluatePosition(position, now);

    if (!decision) {
      continue;
    }

    publishDecision(decision);
  }
}
