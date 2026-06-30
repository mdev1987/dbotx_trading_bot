/**
 * Paper wallet – simulates trade execution without real funds.
 *
 * Every discovered token gets an identical position so the
 * resulting dataset is free of selection bias.
 *
 * Supports partial take-profit fills, trailing stop with
 * activation threshold, backstop TP, and max-slippage exit.
 */

import { CONFIG } from "./config";
import {
  deductWalletBalance,
  addWalletBalance,
  getOpenTradeCount,
  getWalletBalance,
  insertTrade,
  updateTradePnL,
  closeTrade as dbCloseTrade,
  getLatestSnapshot,
  getTradeById,
} from "./db";
import type { ExitReason, TradeRow } from "./models";

/**
 * Open a paper trade for a newly discovered token.
 *
 * 1. Checks wallet balance and max-open-trade limit.
 * 2. Deducts the fixed position size from the paper wallet.
 * 3. Calculates token amount from the available price.
 * 4. Persists the trade and the raw event payload.
 *
 * @param priceSol   Token price in SOL (nullable if not yet known).
 * @param priceUsd   Token price in USD  (nullable if not yet known).
 * @param rawEvent   The raw JSON payload received from DBotX.
 * @returns          The created trade row, or `null` if rejected.
 */
export async function openPaperTrade(
  mint: string,
  pair: string,
  priceSol: number | null,
  priceUsd: number | null,
  rawEvent: unknown,
): Promise<TradeRow | null> {
  const rawJson = JSON.stringify(rawEvent);
  const marketCap =
    rawEvent != null && typeof rawEvent === "object" && "mp" in rawEvent
      ? (rawEvent as Record<string, unknown>).mp as number
      : null;

  /* ---- guard rails ---- */
  const balance = getWalletBalance();
  if (balance < CONFIG.positionSize) {
    console.warn(`[wallet] insufficient balance for ${mint}: ${balance} SOL`);
    return null;
  }

  const openCount = getOpenTradeCount();
  if (openCount >= CONFIG.maxOpenTrades) {
    console.warn(`[wallet] max open trades (${CONFIG.maxOpenTrades}) reached, skipping ${mint}`);
    return null;
  }

  /* ---- execute ---- */
  deductWalletBalance(CONFIG.positionSize);

  const tokenAmount =
    priceSol !== null && priceSol > 0
      ? CONFIG.positionSize / priceSol
      : 0;

  const trade = insertTrade(
    mint,
    pair,
    priceSol,
    priceUsd,
    CONFIG.positionSize,
    tokenAmount,
    CONFIG.ttlSeconds,
    rawJson,
    marketCap,
  );

  console.log(
    `[wallet] BUY  ${mint.slice(0, 8)}..  ${CONFIG.positionSize} SOL` +
      (priceSol !== null ? ` @ ${priceSol} SOL` : " (price pending)"),
  );

  return trade;
}

/**
 * Refresh PnL, highest/lowest prices for an open trade.
 *
 * Called every time a `pairInfo` update arrives so the
 * trade row always reflects the latest market state,
 * accounting for any tokens already sold via partial TPs.
 */
export async function updateTrade(
  tradeId: number,
  currentPriceSol: number | null,
  currentPriceUsd: number | null,
): Promise<void> {
  updateTradePnL(tradeId, currentPriceSol, currentPriceUsd);
}

/**
 * Close an open trade and record the exit price.
 *
 * Fetches the latest snapshot for the trade's mint to
 * determine the exit price at close time. Accounts for
 * any tokens already sold via partial take-profits.
 *
 * @param reason  Why the trade is being closed.
 * @returns       The updated trade row, or `null` if already closed.
 */
export async function closeTrade(
  tradeId: number,
  reason: ExitReason,
): Promise<TradeRow | null> {
  const trade = getTradeById(tradeId);
  if (!trade) return null;

  const snap = getLatestSnapshot(trade.mint);
  const exitPriceSol = snap?.price_sol ?? null;
  const exitPriceUsd = snap?.price_usd ?? null;

  /*
   * `dbCloseTrade` now handles the full PnL including
   * any partial-fill proceeds already banked.
   */
  const updated = dbCloseTrade(tradeId, exitPriceSol, exitPriceUsd, reason);

  if (updated) {
    console.log(
      `[wallet] SELL ${updated.mint.slice(0, 8)}..  ` +
        `PnL: ${updated.pnl_percent !== null ? (updated.pnl_percent * 100).toFixed(2) : "?"}%  ` +
        `reason: ${reason}`,
    );
  }

  return updated;
}
