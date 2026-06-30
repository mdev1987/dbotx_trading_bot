/**
 * TTL Engine – ticks every second and evaluates exit conditions
 * for every open paper trade.
 *
 * Evaluation order (designed so partial TPs and trailing don't fight):
 *
 * 1. **MAX SLIPPAGE**  – panic exit if drawdown exceeds threshold.
 * 2. **PARTIAL TP**    – fill any unmet tier whose target PnL has been reached.
 * 3. **TRAILING STOP** – if activation threshold was breached, check
 *                        whether price has pulled back by the trailing distance.
 * 4. **BACKSTOP TP**   – full-position TP that is rarely hit (500 % etc.).
 * 5. **TTL**           – time-based exit.
 * 6. **STOP LOSS**     – hard floor.
 *
 * Trailing activates *after* the first partial TP has banked some
 * gains, so the trail never pulls the plug before you've locked in
 * a partial win.
 *
 * The user is expected to tune `PAPER_TRAILING_ACTIVATION_PERCENT`
 * to sit just above their first partial TP tier (e.g. 25 % when the
 * first tier is at 20 %) so the trail only engages once meaningful
 * gains are secured.
 */

import { CONFIG } from "./config";
import {
  getOpenTrades,
  getTradeById,
  getLatestSnapshot,
  insertPartialFill,
  getFilledTierIndices,
} from "./db";
import { closeTrade as walletCloseTrade } from "./paper_wallet";
import type { TradeRow, ExitReason } from "./models";

const TICK_INTERVAL_MS = 1_000;
let running = false;
let tickTimer: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// Exit evaluation
// ---------------------------------------------------------------------------

interface ExitAction {
  /** If set, close the remaining position with this reason. */
  close?: ExitReason;
  /** If set, a partial TP tier should be filled. */
  partialTier?: { index: number; pct: number; at: number };
}

/**
 * Evaluate all exit conditions for a single trade.
 *
 * Returns an action describing what to do (close remaining,
 * fill a partial tier, or nothing).
 */
async function evaluateExit(trade: TradeRow): Promise<ExitAction | null> {
  const now = Date.now();
  const ageSeconds = (now - trade.entry_ts) / 1_000;

  /* use the latest market price; fall back to entry price */
  const snap = await getLatestSnapshot(trade.mint);
  const snapPrice = snap?.price_sol ?? null;
  const priceSol = trade.exit_price_sol
    ?? snapPrice
    ?? trade.entry_price_sol
    ?? null;

  /* need a price for most checks */
  if (priceSol === null || priceSol === 0) return null;

  /* skip trades that haven't received their first price yet */
  if (trade.token_amount <= 0) return null;

  const remaining = trade.token_amount - trade.filled_token_amount;
  if (remaining < 1e-9) {
    /* all tokens already sold via partial TPs – close the empty trade */
    return { close: "TAKE_PROFIT" };
  }

  /* current position value including partial proceeds */
  const currentValue = remaining * priceSol + trade.filled_sol_proceeds;
  const pnlPercent =
    trade.amount_sol > 0
      ? (currentValue - trade.amount_sol) / trade.amount_sol
      : null;

  if (pnlPercent === null) return null;

  // ---------------------------------------------------------------
  // 1. MAX SLIPPAGE – panic exit on extreme drawdown
  // ---------------------------------------------------------------
  if (
    CONFIG.maxSlippageExitPct > 0 &&
    pnlPercent <= -CONFIG.maxSlippageExitPct
  ) {
    return { close: "SLIPPAGE" };
  }

  // ---------------------------------------------------------------
  // 2. PARTIAL TAKE-PROFIT TIERS
  // ---------------------------------------------------------------
  if (CONFIG.partialTpTiers.length > 0) {
    const filledTiers = await getFilledTierIndices(trade.id);

    for (let i = 0; i < CONFIG.partialTpTiers.length; i++) {
      const tier = CONFIG.partialTpTiers[i]!;
      if (filledTiers.has(i)) continue;
      if (pnlPercent >= tier.at) {
        return { partialTier: { index: i, pct: tier.pct, at: tier.at } };
      }
    }
  }

  // ---------------------------------------------------------------
  // 3. TRAILING STOP
  // ---------------------------------------------------------------
  const trailingActivated =
    CONFIG.trailingActivationPct > 0 &&
    trade.highest_price !== null &&
    trade.entry_price_sol !== null &&
    trade.entry_price_sol > 0 &&
    (trade.highest_price - trade.entry_price_sol) / trade.entry_price_sol
      >= CONFIG.trailingActivationPct;

  if (trailingActivated && CONFIG.trailingDistancePct > 0) {
    const trailLevel =
      trade.highest_price! * (1 - CONFIG.trailingDistancePct);

    if (priceSol <= trailLevel) {
      return { close: "TRAILING_STOP" };
    }
  }

  // ---------------------------------------------------------------
  // 4. BACKSTOP TAKE-PROFIT (full position)
  // ---------------------------------------------------------------
  if (CONFIG.backstopTpPct > 0 && pnlPercent >= CONFIG.backstopTpPct) {
    return { close: "TAKE_PROFIT" };
  }

  // ---------------------------------------------------------------
  // 5. TTL
  // ---------------------------------------------------------------
  if (ageSeconds >= trade.ttl_seconds) {
    return { close: "TTL" };
  }

  // ---------------------------------------------------------------
  // 6. STOP LOSS
  // ---------------------------------------------------------------
  /*
   * Accept both negative (e.g. -0.15) and positive (e.g. 0.15)
   * config values. Always treat as a loss threshold.
   */
  if (CONFIG.stopLossPct !== 0 && pnlPercent <= -Math.abs(CONFIG.stopLossPct)) {
    return { close: "STOP_LOSS" };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

async function tick(): Promise<void> {
  const trades = await getOpenTrades();

  for (const trade of trades) {
    try {
      const action = await evaluateExit(trade);
      if (!action) continue;

      // --- partial tier fill ---
      if (action.partialTier) {
        const tier = action.partialTier;
        const snap = await getLatestSnapshot(trade.mint);
        const priceSol = snap?.price_sol
          ?? trade.entry_price_sol
          ?? null;

        if (priceSol === null || priceSol === 0) {
          console.warn(
            `[ttl] trade ${trade.id}: partial TP tier ${tier.index} ` +
              `triggered but no price available – deferring`,
          );
          continue;
        }

        const remaining = trade.token_amount - trade.filled_token_amount;

        /*
         * The tier percentage applies to the *original* position,
         * but we only sell what is still left. Cap at remaining.
         */
        const tierTokenAmount = Math.min(
          trade.token_amount * tier.pct,
          remaining,
        );

        const solProceeds = tierTokenAmount * priceSol;

        await insertPartialFill(
          trade.id,
          tier.index,
          tier.pct,
          tier.at,
          tierTokenAmount,
          solProceeds,
          priceSol,
          snap?.price_usd ?? null,
        );

        console.log(
          `[ttl] trade ${trade.id} PARTIAL TP tier ${tier.index} ` +
            `(${(tier.pct * 100).toFixed(0)}% @ +${(tier.at * 100).toFixed(0)}%): ` +
            `sold ${tierTokenAmount.toFixed(4)} tokens for ${solProceeds.toFixed(6)} SOL`,
        );

        continue;
      }

      // --- full close ---
      const updated = await walletCloseTrade(trade.id, action.close!);

      if (updated) {
        console.log(
          `[ttl] trade ${trade.id} CLOSED ${updated.mint.slice(0, 8)}..  ` +
            `PnL: ${updated.pnl_percent !== null ? (updated.pnl_percent * 100).toFixed(2) : "?"}%  ` +
            `reason: ${action.close}`,
        );
      }
    } catch (err) {
      console.error(`[ttl] error processing trade ${trade.id}:`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function startTtlEngine(): void {
  if (running) return;
  running = true;

  console.log(`[ttl] engine started (interval: ${TICK_INTERVAL_MS}ms)`);

  tickTimer = setInterval(tick, TICK_INTERVAL_MS);
  tick();
}

export function stopTtlEngine(): void {
  running = false;
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  console.log("[ttl] engine stopped");
}
