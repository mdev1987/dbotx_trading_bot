import type { PartialTpTier } from "../../config";

export interface StopEarnGroupItem {
  pricePercent: number;
  amountPercent: number;
}

export interface TrailingStopGroupItem {
  pricePercent: number;
  amountPercent: number;
  activePricePercent: number;
}

export function buildStopEarnGroup(tiers: PartialTpTier[], backstopPct: number): StopEarnGroupItem[] {
  const group = tiers.map((tier) => ({
    pricePercent: tier.at,
    amountPercent: tier.pct,
  }));

  if (backstopPct > 0) {
    const totalPct = tiers.reduce((sum, t) => sum + t.pct, 0);
    const remaining = +(1 - totalPct).toFixed(4);
    if (remaining > 0) {
      group.push({ pricePercent: backstopPct, amountPercent: remaining });
    }
  }

  return group;
}

export function buildStopLossGroup(tiers: PartialTpTier[]): StopEarnGroupItem[] {
  return tiers.map((tier) => ({
    pricePercent: Math.abs(tier.at),
    amountPercent: tier.pct,
  }));
}
