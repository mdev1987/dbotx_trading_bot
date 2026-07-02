/**
 * analytics/reports.ts
 *
 * Performance report generator.
 *
 * Queries the SQLite positions table and aggregates win rate,
 * total/avg PnL, best/worst trades, and close-reason breakdown.
 * Used by main.ts on SIGINT to print a summary before exit.
 */

import { getDb } from "./sqlite";

export interface PerformanceReport {
  totalPositions: number;
  closedPositions: number;
  openPositions: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalProfitUsd: number;
  totalProfitPct: number;
  avgProfitPct: number;
  avgProfitUsd: number;
  bestTradePct: number;
  worstTradePct: number;
  reasons: Record<string, number>;
}

export function generateReport(): PerformanceReport {
  const db = getDb();

  const closed = db.query(`
    SELECT
      COUNT(*)                                           AS total_closed,
      SUM(CASE WHEN profit_usd > 0 THEN 1 ELSE 0 END)    AS wins,
      SUM(CASE WHEN profit_usd <= 0 THEN 1 ELSE 0 END)   AS losses,
      COALESCE(SUM(profit_usd), 0)                        AS total_profit_usd,
      COALESCE(SUM(profit_pct), 0)                        AS total_profit_pct,
      COALESCE(AVG(profit_pct), 0)                        AS avg_profit_pct,
      COALESCE(AVG(profit_usd), 0)                        AS avg_profit_usd,
      COALESCE(MAX(profit_pct), 0)                        AS best_trade_pct,
      COALESCE(MIN(profit_pct), 0)                        AS worst_trade_pct
    FROM positions
    WHERE closed_at IS NOT NULL
  `).get() as {
    total_closed: number;
    wins: number;
    losses: number;
    total_profit_usd: number;
    total_profit_pct: number;
    avg_profit_pct: number;
    avg_profit_usd: number;
    best_trade_pct: number;
    worst_trade_pct: number;
  };

  const openCount = db.query(`
    SELECT COUNT(*) AS cnt FROM positions WHERE closed_at IS NULL
  `).get() as { cnt: number };

  const totalCount = db.query(`
    SELECT COUNT(*) AS cnt FROM positions
  `).get() as { cnt: number };

  const reasons = db.query(`
    SELECT close_reason, COUNT(*) AS cnt
    FROM positions
    WHERE closed_at IS NOT NULL
    GROUP BY close_reason
  `).all() as { close_reason: string; cnt: number }[];

  const totalClosed = closed.total_closed;

  return {
    totalPositions: totalCount.cnt,
    closedPositions: totalClosed,
    openPositions: openCount.cnt,
    winningTrades: closed.wins,
    losingTrades: closed.losses,
    winRate: totalClosed > 0 ? (closed.wins / totalClosed) * 100 : 0,
    totalProfitUsd: closed.total_profit_usd,
    totalProfitPct: closed.total_profit_pct,
    avgProfitPct: closed.avg_profit_pct,
    avgProfitUsd: closed.avg_profit_usd,
    bestTradePct: closed.best_trade_pct,
    worstTradePct: closed.worst_trade_pct,
    reasons: Object.fromEntries(
      reasons.map((r) => [r.close_reason, r.cnt]),
    ),
  };
}

export function printReport(r: PerformanceReport): void {
  console.log("=".repeat(50));
  console.log("PERFORMANCE REPORT");
  console.log("=".repeat(50));
  console.log(`Total positions : ${r.totalPositions}`);
  console.log(`Open           : ${r.openPositions}`);
  console.log(`Closed         : ${r.closedPositions}`);
  console.log(`Wins           : ${r.winningTrades}`);
  console.log(`Losses         : ${r.losingTrades}`);
  console.log(`Win rate       : ${r.winRate.toFixed(1)}%`);
  console.log(
    `Total PnL      : $${r.totalProfitUsd.toFixed(2)} (${r.totalProfitPct.toFixed(2)}%)`,
  );
  console.log(
    `Avg PnL        : $${r.avgProfitUsd.toFixed(2)} (${r.avgProfitPct.toFixed(2)}%)`,
  );
  console.log(`Best trade     : ${r.bestTradePct.toFixed(2)}%`);
  console.log(`Worst trade    : ${r.worstTradePct.toFixed(2)}%`);
  console.log(`Close reasons  : ${JSON.stringify(r.reasons)}`);
}
