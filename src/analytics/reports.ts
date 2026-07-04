// Performance report generator that queries the SQLite positions database
import { getDb } from "./sqlite";

/**
 * Aggregated performance report generated from the positions database.
 */
export interface PerformanceReport {
  /** Total positions ever created. */
  totalPositions: number;
  /** Number of fully closed positions. */
  closedPositions: number;
  /** Number of currently open positions. */
  openPositions: number;
  /** Closed positions with positive PnL. */
  winningTrades: number;
  /** Closed positions with negative PnL. */
  losingTrades: number;
  /** Win rate as a percentage (0–100). */
  winRate: number;
  /** Sum of all PnL in USD across closed positions. */
  totalProfitUsd: number;
  /** Total PnL as percentage of total cost basis. */
  totalProfitPct: number;
  /** Average PnL percentage per closed trade. */
  avgProfitPct: number;
  /** Average PnL in USD per closed trade. */
  avgProfitUsd: number;
  /** Highest PnL percentage across all closed trades. */
  bestTradePct: number;
  /** Lowest PnL percentage across all closed trades. */
  worstTradePct: number;
  /** Map of close reason key → count of occurrences. */
  reasons: Record<string, number>;
}

/**
 * Generate a full performance report by querying the positions database.
 *
 * Aggregates all closed positions into summary metrics including win rate,
 * PnL totals, averages, best/worst trades, and close-reason breakdown.
 *
 * @returns A complete PerformanceReport object.
 */
export function generateReport(): PerformanceReport {
  const db = getDb();

  // Query 1: Aggregate metrics for all closed positions (wins, losses, PnL, costs)
  const closed = db.query(`
    SELECT
      COUNT(*)                                                      AS total_closed,
      COALESCE(SUM(CASE WHEN profit_usd > 0 THEN 1 ELSE 0 END), 0) AS wins,
      COALESCE(SUM(CASE WHEN profit_usd < 0 THEN 1 ELSE 0 END), 0) AS losses,
      COALESCE(SUM(profit_usd), 0)                                  AS total_profit_usd,
      COALESCE(AVG(profit_pct), 0)                                  AS avg_profit_pct,
      COALESCE(AVG(profit_usd), 0)                                  AS avg_profit_usd,
      COALESCE(MAX(profit_pct), 0)                                  AS best_trade_pct,
      COALESCE(MIN(profit_pct), 0)                                  AS worst_trade_pct,
      COALESCE(SUM(entry_cost), 0)                                  AS total_cost
    FROM positions
    WHERE closed_at IS NOT NULL
  `).get() as {
    total_closed: number;
    wins: number;
    losses: number;
    total_profit_usd: number;
    avg_profit_pct: number;
    avg_profit_usd: number;
    best_trade_pct: number;
    worst_trade_pct: number;
    total_cost: number;
  };

  // Query 2: Count currently open positions (no closed_at timestamp)
  const openCount = db.query(
    `SELECT COUNT(*) AS cnt FROM positions WHERE closed_at IS NULL`,
  ).get() as { cnt: number };

  // Query 3: Count total positions ever created (open + closed)
  const totalCount = db.query(
    `SELECT COUNT(*) AS cnt FROM positions`,
  ).get() as { cnt: number };

  // Query 4: Group closed positions by close_reason for breakdown
  const reasons = db.query(`
    SELECT close_reason, COUNT(*) AS cnt
    FROM positions
    WHERE closed_at IS NOT NULL
    GROUP BY close_reason
  `).all() as { close_reason: string; cnt: number }[];

  // Derived: total PnL as percentage of total entry cost
  const totalClosed = closed.total_closed;
  const totalProfitPct =
    closed.total_cost > 0
      ? (closed.total_profit_usd / closed.total_cost) * 100
      : 0;

  // Assemble the final report object
  return {
    totalPositions: totalCount.cnt,
    closedPositions: totalClosed,
    openPositions: openCount.cnt,
    winningTrades: closed.wins,
    losingTrades: closed.losses,
    // Win rate = wins / (wins + losses); 0 if no closed trades exist
    winRate: (closed.wins + closed.losses) > 0
      ? (closed.wins / (closed.wins + closed.losses)) * 100
      : 0,
    totalProfitUsd: closed.total_profit_usd,
    totalProfitPct,
    avgProfitPct: closed.avg_profit_pct,
    avgProfitUsd: closed.avg_profit_usd,
    bestTradePct: closed.best_trade_pct,
    worstTradePct: closed.worst_trade_pct,
    // Convert the reasons array [{close_reason, cnt}] → Record<reason, count>
    reasons: Object.fromEntries(
      reasons.map((r) => [r.close_reason, r.cnt]),
    ),
  };
}

/**
 * Get the sum of profit_usd for positions closed today (UTC).
 *
 * @returns Total USD PnL for all positions closed since midnight UTC.
 */
export function getDailyPnlUsd(): number {
  const db = getDb();
  // Calculate the start of the current UTC day (midnight)
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  // Sum profit_usd for positions closed at or after today's UTC midnight
  const row = db
    .query(
      `SELECT COALESCE(SUM(profit_usd), 0) AS total
       FROM positions
       WHERE closed_at >= $start`,
    )
    .get({ $start: startOfDay.getTime() }) as { total: number };
  return row.total;
}

/**
 * Print a formatted performance report to the console.
 *
 * @param r - The performance report to display.
 */
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
