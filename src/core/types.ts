import type { ParsedSignal } from "../telegram/telegram_listener";
import type { PnLTaskSnapshot } from "../simulator/types";

/** Reasons a position can be closed */
export type CloseReason =
  | "take_profit"
  | "stop_loss"
  | "trailing_stop"
  | "trailing_tp"
  | "expired"
  | "manual"
  | "pump_message"
  | "backstop_tp";

/** Lifecycle status of a position */
export type PositionStatus = "open" | "closing" | "closed";

/** Types of events that can be emitted for a position */
export type PositionEventType =
  | "opened"
  | "updated"
  | "closing"
  | "closed"
  | "task_update"
  | "trailing_triggered";

/** Full snapshot of a position at a point in time */
export interface PositionState {
  id: number; // Unique position identifier
  orderId: string; // Exchange order ID
  pair: string; // Trading pair (e.g. SOL/USDC)
  token: string; // Token mint address
  tokenName: string; // Human-readable token name
  tokenSymbol: string; // Token ticker symbol
  entryPriceUsd: number | null; // Price at entry in USD
  entryCostUsd: number | null; // Total cost of entry in USD
  sizeSol: number; // Total position size in SOL
  filledSol: number; // Amount actually filled in SOL
  avgFillPriceUsd: number | null; // Average fill price across partial fills
  peakPriceUsd: number; // Highest price seen since open
  trailingActive: boolean; // Whether trailing stop is engaged
  tasks: Map<number, PnLTaskSnapshot>; // Active PnL task snapshots keyed by task ID
  currentProfitPercent: number; // Current unrealized PnL as percentage
  currentProfitUsd: number; // Current unrealized PnL in USD
  remainingBalance: string; // Unspent balance post-fill
  openedAt: number; // Unix timestamp when position opened
  expiresAt: number; // Unix timestamp when position expires
  lastUpdateAt: number; // Unix timestamp of last state change
  status: PositionStatus; // Current lifecycle status
  closeReason: CloseReason | null; // Reason for closure, null if still open
  exitPriceUsd: number | null; // Exit price in USD, null if not yet closed
  signal: ParsedSignal; // The parsed signal that triggered this position
}

/** Event payload emitted when a position changes state */
export interface PositionEvent {
  type: PositionEventType; // Category of state change
  position: PositionState; // Snapshot of the position at event time
  closeReason?: CloseReason; // Reason if this is a close-related event
  detail?: string; // Optional human-readable detail
}
