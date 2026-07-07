/**
 * Account module — re-exports wallet primitives and provides position-sizing helpers.
 *
 * Position sizing logic:
 *   1. Start with LIVE_CONFIG.positionSize (default 0.1 SOL).
 *   2. Clamp to [minPositionSol, maxPositionSol].
 *   3. Apply risk cap: position must not exceed maxRiskPct of wallet balance,
 *      converted via solPriceUsd to SOL.
 *   4. Return the final size.
 */
import { LIVE_CONFIG } from "./config";
import { latestBalance } from "./wallet";

/**
 * Compute the SOL amount to spend on the next position.
 *
 * Respects absolute caps (min/max) and the relative risk cap (% of wallet balance).
 * The configured minimum position size is ALWAYS enforced as a floor.
 *
 * @returns Position size in SOL.
 */
export function computePositionSize(): number {
  /** Start with the configured default. */
  let size = LIVE_CONFIG.positionSize;

  /** Apply %-of-balance risk cap if we have a balance snapshot and the cap is active. */
  if (latestBalance && LIVE_CONFIG.maxRiskPct > 0) {
    /** The risk limit in raw SOL terms = balance * maxRiskPct. */
    const rawRiskLimitSol = latestBalance.balanceSol * LIVE_CONFIG.maxRiskPct;
    size = Math.min(size, rawRiskLimitSol);
  }

  /** Clamp to configured min/max bounds — MIN is always the absolute floor. */
  size = Math.max(size, LIVE_CONFIG.minPositionSol);
  size = Math.min(size, LIVE_CONFIG.maxPositionSol);

  return size;
}
