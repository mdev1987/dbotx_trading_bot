import { LIVE_CONFIG } from "../config";
import { latestBalance, refreshBalance$ } from "../wallet";
import type { IAccountService } from "../../core/interfaces";
import type { ParsedSignal } from "../../telegram/telegram_listener";

export class LiveAccountService implements IAccountService {
  computePositionSize(_signal?: ParsedSignal): number {
    if (!latestBalance || latestBalance.balanceSol <= 0) {
      return LIVE_CONFIG.minPositionSol;
    }
    const { minPositionSol, maxPositionSol, maxRiskPct } = LIVE_CONFIG;
    let size = maxPositionSol;
    const riskCapSol = (latestBalance.balanceSol * maxRiskPct) / 100;
    size = Math.min(size, riskCapSol);
    return Math.max(minPositionSol, Math.min(size, maxPositionSol));
  }

  getBalance(): number {
    return latestBalance?.balanceSol ?? 0;
  }

  refreshBalance(): void {
    refreshBalance$.next();
  }
}
