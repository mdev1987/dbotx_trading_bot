import type { Position, PositionExitReason } from "../types";

// ============================================================================
// Strategy Actions
// ============================================================================

/**
 * Action requested by an exit strategy.
 *
 * Strategies never execute trades directly. Instead they return an action
 * describing what should happen next.
 */
export enum ExitAction {
  /**
   * Continue monitoring the position.
   */
  Hold = "hold",

  /**
   * Sell part of the position.
   */
  PartialSell = "partial_sell",

  /**
   * Close the entire position.
   */
  Close = "close",

  /**
   * Renew the TTL timer without closing the position.
   */
  Renew = "renew",
}

// ============================================================================
// Position Patch
// ============================================================================

/**
 * Optional changes requested by a strategy.
 *
 * The Position Engine is responsible for applying these updates after the
 * strategy has been evaluated.
 */
export interface PositionPatch {
  /**
   * Next partial take-profit tier.
   */
  partialTierIndex?: number;

  /**
   * New TTL renewal timestamp.
   */
  renewedAt?: number;

  /**
   * Price recorded when TTL was renewed.
   */
  renewPrice?: number;

  /**
   * Updated peak price.
   */
  peakPrice?: number;
}

// ============================================================================
// Strategy Decision
// ============================================================================

/**
 * Decision produced by an exit strategy.
 *
 * Returning `null` means the strategy has no action to perform.
 */
export interface ExitDecision {
  /**
   * Position being evaluated.
   */
  readonly position: Position;

  /**
   * Requested action.
   */
  readonly action: ExitAction;

  /**
   * Exit reason.
   */
  readonly reason: PositionExitReason;

  /**
   * Percentage of the position to sell.
   *
   * Only used for partial exits.
   */
  readonly percentage?: number;

  /**
   * Optional state updates.
   */
  readonly patch?: PositionPatch;

  /**
   * Optional metadata for logging, debugging and analytics.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ============================================================================
// Strategy Interface
// ============================================================================

/**
 * Common interface implemented by every exit strategy.
 *
 * Strategies should be deterministic and side-effect free:
 *
 * • They must not execute trades.
 * • They must not mutate positions.
 * • They simply evaluate a position and return an ExitDecision.
 */
export interface ExitStrategy {
  /**
   * Unique strategy identifier.
   */
  readonly name: string;

  /**
   * Evaluates a position.
   *
   * Returns null when the strategy does not wish to take any action.
   */
  check(position: Position, now: number): ExitDecision | null;
}

// ============================================================================
// Strategy Metadata
// ============================================================================

/**
 * Optional information describing a strategy.
 *
 * Useful for dashboards, logging and diagnostics.
 */
export interface StrategyInfo {
  /**
   * Unique strategy identifier.
   */
  readonly name: string;

  /**
   * Human-readable strategy name.
   */
  readonly displayName: string;

  /**
   * Whether the strategy is currently enabled.
   */
  readonly enabled: boolean;

  /**
   * Execution priority.
   *
   * Lower numbers are evaluated first.
   */
  readonly priority: number;
}

// ============================================================================
// Utility Types
// ============================================================================

/**
 * Read-only list of registered strategies.
 */
export type ExitStrategyList = readonly ExitStrategy[];

/**
 * Read-only list of strategy metadata.
 */
export type StrategyInfoList = readonly StrategyInfo[];
