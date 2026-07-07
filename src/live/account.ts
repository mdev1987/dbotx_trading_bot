import { LIVE_CONFIG } from "./config";
import { latestBalance } from "./wallet";

export function computePositionSize(): number {
  if (!latestBalance || latestBalance.balanceSol <= 0) {
    return LIVE_CONFIG.minPositionSol;
  }

  const { minPositionSol, maxPositionSol, maxRiskPct } = LIVE_CONFIG;
  let size = maxPositionSol;

  const riskCapSol = (latestBalance.balanceSol * maxRiskPct) / 100;
  size = Math.min(size, riskCapSol);

  return Math.max(minPositionSol, Math.min(size, maxPositionSol));
}
