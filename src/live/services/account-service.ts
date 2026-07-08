import { LIVE_CONFIG } from "../config";
import { latestBalance, refreshBalance$ } from "../wallet";
import type { IAccountService } from "../../core/interfaces";
import type { ParsedSignal } from "../../telegram/telegram_listener";

/** Service for computing position sizes and managing wallet balance in the live trading environment */
export class LiveAccountService implements IAccountService {
  /**
   * Compute the position size for a trade, respecting min/max and risk caps based on current balance
   * @param _signal - Optional signal (currently unused in sizing logic)
   * @returns The computed position size in SOL
   */
  computePositionSize(_signal?: ParsedSignal): number {
    // Fall back to minimum position if balance is unavailable or zero
    if (!latestBalance || latestBalance.balanceSol <= 0) {
      return LIVE_CONFIG.minPositionSol;
    }
    const { minPositionSol, maxPositionSol, maxRiskPct } = LIVE_CONFIG;
    let size = maxPositionSol; // Start with the configured maximum position
    const riskCapSol = (latestBalance.balanceSol * maxRiskPct) / 100; // Max SOL at risk based on balance %
    size = Math.min(size, riskCapSol); // Clamp to the risk cap
    return Math.max(minPositionSol, Math.min(size, maxPositionSol)); // Ensures result is within [min, max]
  }

  /** Get the current wallet balance in SOL, or 0 if not yet loaded */
  getBalance(): number {
    return latestBalance?.balanceSol ?? 0;
  }

  /** Trigger a wallet balance refresh via the reactive subject */
  refreshBalance(): void {
    refreshBalance$.next(); // Emit a value on the subject to trigger a refresh
  }
}
