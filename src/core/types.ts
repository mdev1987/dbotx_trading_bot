import type { ParsedSignal } from "../telegram/telegram_listener";
import type { PnLTaskSnapshot } from "../simulator/types";

export type CloseReason =
  | "take_profit"
  | "stop_loss"
  | "trailing_stop"
  | "trailing_tp"
  | "expired"
  | "manual"
  | "pump_message"
  | "backstop_tp";

export type PositionStatus = "open" | "closing" | "closed";

export type PositionEventType =
  | "opened"
  | "updated"
  | "closing"
  | "closed"
  | "task_update"
  | "trailing_triggered";

export interface PositionState {
  id: number;
  orderId: string;
  pair: string;
  token: string;
  tokenName: string;
  tokenSymbol: string;
  entryPriceUsd: number | null;
  entryCostUsd: number | null;
  sizeSol: number;
  filledSol: number;
  avgFillPriceUsd: number | null;
  peakPriceUsd: number;
  trailingActive: boolean;
  tasks: Map<number, PnLTaskSnapshot>;
  currentProfitPercent: number;
  currentProfitUsd: number;
  remainingBalance: string;
  openedAt: number;
  expiresAt: number;
  lastUpdateAt: number;
  status: PositionStatus;
  closeReason: CloseReason | null;
  exitPriceUsd: number | null;
  signal: ParsedSignal;
}

export interface PositionEvent {
  type: PositionEventType;
  position: PositionState;
  closeReason?: CloseReason;
  detail?: string;
}
