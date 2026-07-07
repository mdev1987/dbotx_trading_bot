/**
 * Account module — simple balance-based position sizing.
 *
 * Formula: clamp(0.01 SOL, 10 % of wallet balance, 0.05 SOL)
 *
 * If no balance snapshot is available, returns the conservative minimum of 0.01 SOL.
 */
import { latestBalance } from "./wallet";

const MIN_POSITION_SOL = 0.01;
const MAX_POSITION_SOL = 0.05;
const BALANCE_FRACTION = 0.10;

/**
 * Compute the SOL amount for the next position.
 *
 * @returns Position size in SOL, never below 0.01 or above 0.05.
 */
export function computePositionSize(): number {
  if (!latestBalance || latestBalance.balanceSol <= 0) {
    return MIN_POSITION_SOL;
  }

  const bal = latestBalance.balanceSol;
  const tenPct = bal * BALANCE_FRACTION;
  return Math.max(MIN_POSITION_SOL, Math.min(tenPct, MAX_POSITION_SOL));
}
