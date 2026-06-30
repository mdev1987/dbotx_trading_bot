import { db } from "./db";
import { CONFIG } from "./config";

export interface SummaryReport {
  totalTrades: number;
  closedTrades: number;
  openTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnlSol: number;
  avgPnlPercent: number;
  bestTrade: number;
  worstTrade: number;
  avgHoldSeconds: number;
  avgEntryMarketCap: number | null;
}

export interface BucketRow {
  bucket: number;
  avg_pnl: number;
  trades: number;
  wins: number;
  win_rate: number;
}

/**
 * Overall performance summary.
 */
export async function summary(): Promise<SummaryReport> {
  const [stats] = await db`
    SELECT
       COUNT(*)                                                AS total,
       SUM(CASE WHEN open = 0 THEN 1 ELSE 0 END)               AS closed,
       SUM(CASE WHEN open = 1 THEN 1 ELSE 0 END)               AS open,
       SUM(CASE WHEN open = 0 AND pnl_percent > 0 THEN 1 ELSE 0 END) AS wins,
       SUM(CASE WHEN open = 0 AND pnl_percent <= 0 THEN 1 ELSE 0 END) AS losses,
       COALESCE(SUM(CASE WHEN open = 0 THEN pnl_sol ELSE 0 END), 0)   AS total_pnl,
       AVG(CASE WHEN open = 0 THEN pnl_percent ELSE NULL END)         AS avg_pnl,
       MAX(CASE WHEN open = 0 THEN pnl_percent ELSE NULL END)         AS best,
       MIN(CASE WHEN open = 0 THEN pnl_percent ELSE NULL END)         AS worst,
       AVG(CASE WHEN open = 0 THEN hold_seconds ELSE NULL END)        AS avg_hold,
       AVG(entry_market_cap)                                          AS avg_entry_mcap
     FROM trades
  ` as {
    total: number;
    closed: number;
    open: number;
    wins: number;
    losses: number;
    total_pnl: number;
    avg_pnl: number | null;
    best: number | null;
    worst: number | null;
    avg_hold: number | null;
    avg_entry_mcap: number | null;
  }[];

  /* aggregate query always returns one row */
  const s = stats!;

  const closed = s.closed || 0;

  return {
    totalTrades: s.total,
    closedTrades: closed,
    openTrades: s.open,
    wins: s.wins,
    losses: s.losses,
    winRate: closed > 0 ? (s.wins / closed) : 0,
    totalPnlSol: s.total_pnl,
    avgPnlPercent: s.avg_pnl ?? 0,
    bestTrade: s.best ?? 0,
    worstTrade: s.worst ?? 0,
    avgHoldSeconds: s.avg_hold ?? 0,
    avgEntryMarketCap: s.avg_entry_mcap ?? null,
  };
}

/**
 * Win rate bucketed by TTL duration.
 */
export async function ttlAnalysis(): Promise<BucketRow[]> {
  return await db`
    SELECT
       ttl_seconds AS bucket,
       AVG(pnl_percent)          AS avg_pnl,
       COUNT(*)                  AS trades,
       SUM(CASE WHEN pnl_percent > 0 THEN 1 ELSE 0 END) AS wins,
       CAST(SUM(CASE WHEN pnl_percent > 0 THEN 1 ELSE 0 END) AS REAL)
         / MAX(COUNT(*), 1)       AS win_rate
     FROM trades
     WHERE open = 0
     GROUP BY ttl_seconds
     ORDER BY ttl_seconds
  ` as BucketRow[];
}

/**
 * Win rate by holder count at entry.
 */
export async function holderAnalysis(): Promise<BucketRow[]> {
  return await db`
    SELECT
       CAST(ROUND(holders / 10) * 10 AS INTEGER) AS bucket,
       AVG(pnl_percent)            AS avg_pnl,
       COUNT(*)                    AS trades,
       SUM(CASE WHEN pnl_percent > 0 THEN 1 ELSE 0 END) AS wins,
       CAST(SUM(CASE WHEN pnl_percent > 0 THEN 1 ELSE 0 END) AS REAL)
         / MAX(COUNT(*), 1)         AS win_rate
     FROM trades
     WHERE open = 0 AND holders IS NOT NULL
     GROUP BY bucket
     ORDER BY bucket
  ` as BucketRow[];
}

/**
 * Win rate by market cap bucket (USD, bucketed by $10k).
 */
export async function marketCapAnalysis(): Promise<BucketRow[]> {
  return await db`
    SELECT
       CAST(ROUND(entry_market_cap / 10000) * 10000 AS INTEGER) AS bucket,
       AVG(pnl_percent)            AS avg_pnl,
       COUNT(*)                    AS trades,
       SUM(CASE WHEN pnl_percent > 0 THEN 1 ELSE 0 END) AS wins,
       CAST(SUM(CASE WHEN pnl_percent > 0 THEN 1 ELSE 0 END) AS REAL)
         / MAX(COUNT(*), 1)         AS win_rate
     FROM trades
     WHERE open = 0 AND entry_market_cap IS NOT NULL
     GROUP BY bucket
     ORDER BY bucket
  ` as BucketRow[];
}

/**
 * Win rate by liquidity bucket (SOL).
 */
export async function liquidityAnalysis(): Promise<BucketRow[]> {
  return await db`
    SELECT
       CAST(ROUND(entry_liquidity / 10) * 10 AS INTEGER) AS bucket,
       AVG(pnl_percent)            AS avg_pnl,
       COUNT(*)                    AS trades,
       SUM(CASE WHEN pnl_percent > 0 THEN 1 ELSE 0 END) AS wins,
       CAST(SUM(CASE WHEN pnl_percent > 0 THEN 1 ELSE 0 END) AS REAL)
         / MAX(COUNT(*), 1)         AS win_rate
     FROM trades
     WHERE open = 0 AND entry_liquidity IS NOT NULL
     GROUP BY bucket
     ORDER BY bucket
  ` as BucketRow[];
}

/**
 * Average return by age of token (seconds since first seen).
 */
export async function ageAnalysis(): Promise<
  { age_bucket_seconds: number; avg_pnl: number; trades: number }[]
> {
  return await db`
    SELECT
       CAST(ROUND((t.entry_ts - tk.first_seen) / 60) * 60 AS INTEGER) AS age_bucket_seconds,
       AVG(t.pnl_percent) AS avg_pnl,
       COUNT(*)           AS trades
     FROM trades t
     JOIN tokens tk ON tk.mint = t.mint
     WHERE t.open = 0
     GROUP BY age_bucket_seconds
     ORDER BY age_bucket_seconds
  ` as { age_bucket_seconds: number; avg_pnl: number; trades: number }[];
}

/**
 * Distribution of hold times (seconds).
 */
export async function holdTimeAnalysis(): Promise<
  { hold_bucket: number; trades: number; avg_pnl: number }[]
> {
  return await db`
    SELECT
       CAST(ROUND(hold_seconds / 30) * 30 AS INTEGER) AS hold_bucket,
       COUNT(*)      AS trades,
       AVG(pnl_percent) AS avg_pnl
     FROM trades
     WHERE open = 0 AND hold_seconds IS NOT NULL
     GROUP BY hold_bucket
     ORDER BY hold_bucket
  ` as { hold_bucket: number; trades: number; avg_pnl: number }[];
}

/**
 * Sharpe ratio (annualised, risk-free ≈ 0).
 */
export async function sharpeRatio(): Promise<number> {
  const rows = await db`
    SELECT pnl_percent AS r
    FROM trades
    WHERE open = 0 AND pnl_percent IS NOT NULL
  ` as { r: number }[];

  if (rows.length < 2) return 0;

  const mean = rows.reduce((s, x) => s + x.r, 0) / rows.length;
  const variance =
    rows.reduce((s, x) => s + (x.r - mean) ** 2, 0) / (rows.length - 1);

  const std = Math.sqrt(variance);
  if (std === 0) return 0;

  /*
   * Assumes ~50,000 trades per year for a 24/7 market.
   * Adjust the scaling factor to match your observed trade frequency.
   */
  const tradesPerYear = 50_000;
  return (mean / std) * Math.sqrt(tradesPerYear);
}

export interface SignalProfile {
  avgHolders: number | null;
  avgMarketCapUsd: number | null;
  avgLiquiditySol: number | null;
  avgTop10: number | null;
  avgDevHoldings: number | null;
  avgPriceChange1m: number | null;
  avgPnlPercent: number;
  tradeCount: number;
}

/**
 * Profile of the best-performing quarter of closed trades.
 * Averages their entry on-chain characteristics so you can
 * see what a winning setup looks like.
 */
export async function bestSignalParameters(): Promise<SignalProfile | null> {
  const [row] = await db`
    SELECT
       AVG(s.holders)            AS avg_holders,
       AVG(s.market_cap)         AS avg_market_cap,
       AVG(s.liquidity)          AS avg_liquidity,
       AVG(s.top10)              AS avg_top10,
       AVG(s.dev_holdings)       AS avg_dev_holdings,
       AVG(s.price_change_1m)    AS avg_pc1m,
       AVG(t.pnl_percent)        AS avg_pnl,
       COUNT(*)                  AS cnt
     FROM (
       SELECT id, pnl_percent
       FROM trades
       WHERE open = 0 AND pnl_percent IS NOT NULL
       ORDER BY pnl_percent DESC
       LIMIT MAX(1, (SELECT COUNT(*) FROM trades WHERE open = 0 AND pnl_percent IS NOT NULL) / 4)
     ) t
     LEFT JOIN snapshots s ON s.id = (
       SELECT id FROM snapshots
       WHERE mint = (SELECT mint FROM trades WHERE id = t.id)
         AND ts <= (SELECT entry_ts FROM trades WHERE id = t.id)
       ORDER BY ts DESC LIMIT 1
     )
  ` as {
    avg_holders: number | null;
    avg_market_cap: number | null;
    avg_liquidity: number | null;
    avg_top10: number | null;
    avg_dev_holdings: number | null;
    avg_pc1m: number | null;
    avg_pnl: number | null;
    cnt: number | null;
  }[];

  if (!row || !row.cnt) return null;

  return {
    avgHolders: row.avg_holders ?? null,
    avgMarketCapUsd: row.avg_market_cap ?? null,
    avgLiquiditySol: row.avg_liquidity ?? null,
    avgTop10: row.avg_top10 ?? null,
    avgDevHoldings: row.avg_dev_holdings ?? null,
    avgPriceChange1m: row.avg_pc1m ?? null,
    avgPnlPercent: row.avg_pnl ?? 0,
    tradeCount: row.cnt,
  };
}

/**
 * Profile of the worst-performing quarter of closed trades.
 */
export async function worstSignalParameters(): Promise<SignalProfile | null> {
  const [row] = await db`
    SELECT
       AVG(s.holders)            AS avg_holders,
       AVG(s.market_cap)         AS avg_market_cap,
       AVG(s.liquidity)          AS avg_liquidity,
       AVG(s.top10)              AS avg_top10,
       AVG(s.dev_holdings)       AS avg_dev_holdings,
       AVG(s.price_change_1m)    AS avg_pc1m,
       AVG(t.pnl_percent)        AS avg_pnl,
       COUNT(*)                  AS cnt
     FROM (
       SELECT id, pnl_percent
       FROM trades
       WHERE open = 0 AND pnl_percent IS NOT NULL
       ORDER BY pnl_percent ASC
       LIMIT MAX(1, (SELECT COUNT(*) FROM trades WHERE open = 0 AND pnl_percent IS NOT NULL) / 4)
     ) t
     LEFT JOIN snapshots s ON s.id = (
       SELECT id FROM snapshots
       WHERE mint = (SELECT mint FROM trades WHERE id = t.id)
         AND ts <= (SELECT entry_ts FROM trades WHERE id = t.id)
       ORDER BY ts DESC LIMIT 1
     )
  ` as {
    avg_holders: number | null;
    avg_market_cap: number | null;
    avg_liquidity: number | null;
    avg_top10: number | null;
    avg_dev_holdings: number | null;
    avg_pc1m: number | null;
    avg_pnl: number | null;
    cnt: number | null;
  }[];

  if (!row || !row.cnt) return null;

  return {
    avgHolders: row.avg_holders ?? null,
    avgMarketCapUsd: row.avg_market_cap ?? null,
    avgLiquiditySol: row.avg_liquidity ?? null,
    avgTop10: row.avg_top10 ?? null,
    avgDevHoldings: row.avg_dev_holdings ?? null,
    avgPriceChange1m: row.avg_pc1m ?? null,
    avgPnlPercent: row.avg_pnl ?? 0,
    tradeCount: row.cnt,
  };
}

/**
 * Maximum drawdown (peak-to-trough of the equity curve).
 *
 * Walks trades in chronological order and recomputes equity
 * after each close.
 */
export async function maxDrawdown(): Promise<{
  maxDrawdownPercent: number;
  peakEquity: number;
  troughEquity: number;
}> {
  const rows = await db`
    SELECT entry_ts, pnl_sol
    FROM trades
    WHERE open = 0 AND pnl_sol IS NOT NULL
    ORDER BY entry_ts ASC
  ` as { entry_ts: number; pnl_sol: number }[];

  /*
   * Walk trades chronologically. Each closed trade's net effect on
   * wallet equity is +pnl_sol (entry deducts amount_sol, exit adds
   * amount_sol + pnl_sol, net = pnl_sol). Start from the initial
   * wallet balance and accumulate sequentially.
   */
  let equity = CONFIG.startingBalance;
  let peak = equity;
  let trough = equity;
  let maxDd = 0;

  for (const row of rows) {
    equity += row.pnl_sol;

    if (equity > peak) peak = equity;
    if (equity < trough) trough = equity;

    const dd = peak > 0 ? (peak - equity) / peak : 0;
    if (dd > maxDd) maxDd = dd;
  }

  return {
    maxDrawdownPercent: maxDd,
    peakEquity: peak,
    troughEquity: trough,
  };
}
