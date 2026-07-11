import { Subject } from "rxjs";

import { CONFIG } from "../config";
import { positions } from "./positions_store";
import type { Position } from "./types";
import { PositionExitReason } from "./types";

/* -------------------------------------------------------------------------- */
/*                                   Events                                   */
/* -------------------------------------------------------------------------- */

export const positionExitRequested$ = new Subject<{
  position: Position;
  reason: PositionExitReason;
}>();

export const positionPartialSellRequested$ = new Subject<{
  position: Position;
  percentage: number;
}>();

/* -------------------------------------------------------------------------- */
/*                              Position Scanner                              */
/* -------------------------------------------------------------------------- */

export function scanPositions(): void {
  const now = Date.now();

  for (const position of positions.values()) {
    if (position.status !== "open") {
      continue;
    }

    checkStopLoss(position);
    checkTrailingStop(position);
    checkPartialTakeProfit(position);
    checkPositionTTL(position, now);
  }
}

/* -------------------------------------------------------------------------- */
/*                                Stop Loss                                   */
/* -------------------------------------------------------------------------- */

function checkStopLoss(position: Position): void {
  if (!CONFIG.stopLossEnabled) {
    return;
  }

  if (position.currentProfitPct > CONFIG.stopLossPct) {
    return;
  }

  positionExitRequested$.next({
    position,
    reason: PositionExitReason.StopLoss,
  });
}

/* -------------------------------------------------------------------------- */
/*                              Trailing Stop                                 */
/* -------------------------------------------------------------------------- */

function checkTrailingStop(position: Position): void {
  const peakProfit =
    (position.peakPriceUsd - position.entryPriceUsd) / position.entryPriceUsd;

  if (peakProfit < CONFIG.trailingActivationPct) {
    return;
  }

  const drawdown = peakProfit - position.currentProfitPct;

  if (drawdown < CONFIG.trailingDistancePct) {
    return;
  }

  positionExitRequested$.next({
    position,
    reason: PositionExitReason.TrailingStop,
  });
}

/* -------------------------------------------------------------------------- */
/*                           Partial Take Profit                              */
/* -------------------------------------------------------------------------- */

function checkPartialTakeProfit(position: Position): void {
  if (!CONFIG.partialTpEnabled) {
    return;
  }

  const tiers = CONFIG.partialTpTiers;

  while (position.partialTierIndex < tiers.length) {
    const tier = tiers[position.partialTierIndex]!;

    if (position.currentProfitPct < tier.at) {
      break;
    }

    position.partialTierIndex++;

    positionPartialSellRequested$.next({
      position,
      percentage: tier.pct,
    });
  }
}

/* -------------------------------------------------------------------------- */
/*                                    TTL                                     */
/* -------------------------------------------------------------------------- */

function checkPositionTTL(position: Position, now: number): void {
  const ageSeconds = (now - position.openedAt) / 1000;

  if (ageSeconds < CONFIG.baseTtlSecs) {
    return;
  }

  const profitable =
    position.currentProfitPct >= CONFIG.minProfitForTtlExtensionPct;

  if (profitable && ageSeconds < CONFIG.maxTtlSecs) {
    return;
  }

  positionExitRequested$.next({
    position,
    reason: PositionExitReason.Expired,
  });
}
