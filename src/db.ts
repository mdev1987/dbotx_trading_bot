/**
 * SQLite persistence layer backed by bun:sqlite.
 *
 * Schema is designed for research-grade paper trading:
 * every event is saved as raw JSON alongside normalised columns
 * so no information is ever lost.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { CONFIG } from "./config";
import type {
  WalletRow,
  TokenRow,
  TradeRow,
  SnapshotRow,
  PartialFillRow,
  ExitReason,
} from "./models";

const dbDir = dirname(CONFIG.sqlitePath);
if (!existsSync(dbDir)) {
  mkdirSync(dbDir, { recursive: true });
}

export const db = new Database(CONFIG.sqlitePath, { create: true });

/**
 * Create all tables and indexes if they do not exist.
 * Idempotent – safe to call on every startup.
 * Runs ALTER TABLE ADD COLUMN for any schema additions
 * that may have been added after the initial creation.
 */
export function initializeDatabase(): void {
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA busy_timeout = 5000;");

  db.run(`
    CREATE TABLE IF NOT EXISTS wallet(
      id INTEGER PRIMARY KEY,
      balance_sol REAL NOT NULL,
      equity_sol REAL NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS tokens(
      mint TEXT PRIMARY KEY,
      pair TEXT,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      first_price_usd REAL,
      first_market_cap REAL,
      first_liquidity REAL,
      raw_json TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS trades(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL,
      pair TEXT,
      entry_ts INTEGER NOT NULL,
      exit_ts INTEGER,
      ttl_seconds INTEGER NOT NULL,
      entry_price_sol REAL,
      entry_price_usd REAL,
      exit_price_sol REAL,
      exit_price_usd REAL,
      amount_sol REAL NOT NULL,
      token_amount REAL NOT NULL,
      filled_token_amount REAL NOT NULL DEFAULT 0,
      filled_sol_proceeds REAL NOT NULL DEFAULT 0,
      pnl_sol REAL,
      pnl_percent REAL,
      highest_price REAL,
      lowest_price REAL,
      hold_seconds INTEGER,
      exit_reason TEXT,
      open INTEGER NOT NULL,
      entry_snapshot_id INTEGER,
      raw_entry_json TEXT,
      raw_exit_json TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS snapshots(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_id INTEGER,
      mint TEXT NOT NULL,
      ts INTEGER NOT NULL,
      price_sol REAL,
      price_usd REAL,
      market_cap REAL,
      holders INTEGER,
      liquidity REAL,
      buy_tx_1m INTEGER,
      sell_tx_1m INTEGER,
      buy_volume_1m REAL,
      sell_volume_1m REAL,
      buy_tx_5m INTEGER,
      sell_tx_5m INTEGER,
      buy_volume_5m REAL,
      sell_volume_5m REAL,
      buy_tx_1h INTEGER,
      sell_tx_1h INTEGER,
      buy_volume_1h REAL,
      sell_volume_1h REAL,
      price_change_1m REAL,
      price_change_5m REAL,
      price_change_1h REAL,
      top10 REAL,
      dev_holdings REAL,
      freeze_authority INTEGER,
      mint_authority INTEGER,
      raw_json TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS raw_events(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_ts INTEGER NOT NULL,
      event_type TEXT,
      mint TEXT,
      pair TEXT,
      payload TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS partial_fills(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_id INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      tier_index INTEGER NOT NULL,
      tier_pct REAL NOT NULL,
      tier_target_pct REAL NOT NULL,
      token_amount REAL NOT NULL,
      sol_proceeds REAL NOT NULL,
      price_sol REAL,
      price_usd REAL,
      FOREIGN KEY(trade_id) REFERENCES trades(id)
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_trade_mint
    ON trades(mint)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_trade_open
    ON trades(open)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_snapshot_mint
    ON snapshots(mint)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_snapshot_ts
    ON snapshots(ts)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_snapshot_trade_id
    ON snapshots(trade_id)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_raw_events_mint
    ON raw_events(mint)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_raw_events_ts
    ON raw_events(event_ts)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_partial_fills_trade
    ON partial_fills(trade_id)
  `);

  /* ---- migrate legacy tables that may lack new columns ---- */
  for (const col of ["filled_token_amount", "filled_sol_proceeds"]) {
    try {
      db.run(`ALTER TABLE trades ADD COLUMN ${col} REAL NOT NULL DEFAULT 0`);
    } catch {
      /* column already exists – ignore */
    }
  }

  const existing = db
    .query("SELECT COUNT(*) AS c FROM wallet")
    .get() as { c: number };

  if (existing.c === 0) {
    const now = Date.now();
    db.query(
      `INSERT INTO wallet(id, balance_sol, equity_sol, updated_at)
       VALUES (1, ?, ?, ?)`,
    ).run(CONFIG.startingBalance, CONFIG.startingBalance, now);

    console.log(`[db] wallet initialised: ${CONFIG.startingBalance} SOL`);
  }
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/**
 * Upsert a token record – insert on first sight, update `last_seen`
 * and price fields on subsequent appearances.
 */
export function upsertToken(
  mint: string,
  pair: string | null,
  priceUsd: number | null,
  marketCap: number | null,
  liquidity: number | null,
  rawJson: string,
): void {
  const now = Date.now();

  const existing = db
    .query("SELECT first_price_usd FROM tokens WHERE mint = ?")
    .get(mint) as { first_price_usd: number | null } | null;

  if (existing) {
    db.query(
      `UPDATE tokens
         SET last_seen = ?,
             raw_json = ?
       WHERE mint = ?`,
    ).run(now, rawJson, mint);
  } else {
    db.query(
      `INSERT INTO tokens(mint, pair, first_seen, last_seen,
                          first_price_usd, first_market_cap,
                          first_liquidity, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      mint,
      pair,
      now,
      now,
      priceUsd,
      marketCap,
      liquidity,
      rawJson,
    );
  }
}

// ---------------------------------------------------------------------------
// Trades
// ---------------------------------------------------------------------------

export function insertTrade(
  mint: string,
  pair: string | null,
  priceSol: number | null,
  priceUsd: number | null,
  amountSol: number,
  tokenAmount: number,
  ttlSeconds: number,
  rawJson: string,
  marketCap: number | null,
): TradeRow {
  const now = Date.now();

  const info = db
    .query(
      `INSERT INTO trades(
          mint, pair, entry_ts, ttl_seconds,
          entry_price_sol, entry_price_usd,
          amount_sol, token_amount,
          filled_token_amount, filled_sol_proceeds,
          open, raw_entry_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 1, ?)
        RETURNING *`,
    )
    .get(
      mint,
      pair,
      now,
      ttlSeconds,
      priceSol,
      priceUsd,
      amountSol,
      tokenAmount,
      rawJson,
    ) as TradeRow;

  return info;
}

export function getOpenTrades(): TradeRow[] {
  return db
    .query(
      `SELECT * FROM trades
       WHERE open = 1
       ORDER BY entry_ts ASC`,
    )
    .all() as TradeRow[];
}

export function getTradeById(id: number): TradeRow | null {
  return db
    .query("SELECT * FROM trades WHERE id = ?")
    .get(id) as TradeRow | null;
}

export function getLatestSnapshot(mint: string): SnapshotRow | null {
  return db
    .query(
      `SELECT * FROM snapshots
       WHERE mint = ?
       ORDER BY ts DESC
       LIMIT 1`,
    )
    .get(mint) as SnapshotRow | null;
}

/**
 * Compute unrealised PnL accounting for any tokens already
 * sold via partial take-profits.
 *
 *   remaining_tokens = token_amount - filled_token_amount
 *   current_value    = remaining_tokens * price_sol + filled_sol_proceeds
 *   pnl_sol          = current_value - amount_sol
 *   pnl_percent      = pnl_sol / amount_sol
 */
function computePnL(
  trade: TradeRow,
  priceSol: number | null,
): { pnlSol: number | null; pnlPercent: number | null } {
  if (priceSol === null || priceSol === 0) {
    return { pnlSol: null, pnlPercent: null };
  }

  const remaining = trade.token_amount - trade.filled_token_amount;
  const currentValue = remaining * priceSol + trade.filled_sol_proceeds;
  const pnlSol = currentValue - trade.amount_sol;
  const pnlPercent = trade.amount_sol > 0 ? pnlSol / trade.amount_sol : null;

  return { pnlSol, pnlPercent };
}

export function updateTradePnL(
  id: number,
  priceSol: number | null,
  priceUsd: number | null,
): void {
  const trade = getTradeById(id);
  if (!trade) return;

  /* initialise token_amount when the first price arrives */
  if (trade.token_amount === 0 && priceSol !== null && priceSol > 0) {
    const newTokenAmount = trade.amount_sol / priceSol;
    db.query("UPDATE trades SET token_amount = ? WHERE id = ?").run(newTokenAmount, id);
    trade.token_amount = newTokenAmount;
  }

  let highestPrice = trade.highest_price ?? priceSol;
  let lowestPrice = trade.lowest_price ?? priceSol;

  if (priceSol !== null) {
    if (highestPrice === null || priceSol > highestPrice) {
      highestPrice = priceSol;
    }
    if (lowestPrice === null || priceSol < lowestPrice) {
      lowestPrice = priceSol;
    }
  }

  const { pnlSol, pnlPercent } = computePnL(trade, priceSol);

  db.query(
    `UPDATE trades
     SET entry_price_sol    = COALESCE(entry_price_sol, ?),
         entry_price_usd    = COALESCE(entry_price_usd, ?),
         pnl_sol            = ?,
         pnl_percent        = ?,
         highest_price      = ?,
         lowest_price       = ?
     WHERE id = ?`,
  ).run(
    priceSol,
    priceUsd,
    pnlSol,
    pnlPercent,
    highestPrice,
    lowestPrice,
    id,
  );
}

/**
 * Close the remaining position of an open trade.
 *
 * Sells `token_amount - filled_token_amount` tokens at
 * `priceSol` and records the final PnL including all
 * prior partial-fill proceeds.
 */
export function closeTrade(
  id: number,
  priceSol: number | null,
  priceUsd: number | null,
  reason: ExitReason,
): TradeRow | null {
  const trade = getTradeById(id);
  if (!trade || !trade.open) return null;

  const now = Date.now();
  const holdSeconds = Math.floor((now - trade.entry_ts) / 1000);

  let { pnlSol, pnlPercent } = computePnL(trade, priceSol);

  /* exiting actual price equals the argument for remaining fill */
  let exitPriceSol: number | null = priceSol;
  let exitPriceUsd: number | null = priceUsd;

  /* if we lacked a live price, fall back to last snapshot */
  if (exitPriceSol === null) {
    const snap = getLatestSnapshot(trade.mint);
    exitPriceSol = snap?.price_sol ?? null;
    exitPriceUsd = snap?.price_usd ?? null;
    /* recompute PnL with the found price */
    const recomputed = computePnL(trade, exitPriceSol);
    pnlSol = recomputed.pnlSol;
    pnlPercent = recomputed.pnlPercent;
  }

  let highestPrice = trade.highest_price ?? exitPriceSol;
  let lowestPrice = trade.lowest_price ?? exitPriceSol;

  if (exitPriceSol !== null) {
    if (highestPrice === null || exitPriceSol > highestPrice) {
      highestPrice = exitPriceSol;
    }
    if (lowestPrice === null || exitPriceSol < lowestPrice) {
      lowestPrice = exitPriceSol;
    }
  }

  db.query(
    `UPDATE trades
     SET exit_ts          = ?,
         exit_price_sol   = ?,
         exit_price_usd   = ?,
         pnl_sol          = ?,
         pnl_percent      = ?,
         highest_price    = ?,
         lowest_price     = ?,
         hold_seconds     = ?,
         exit_reason      = ?,
         open             = 0
     WHERE id = ?`,
  ).run(
    now,
    exitPriceSol,
    exitPriceUsd,
    pnlSol,
    pnlPercent,
    highestPrice,
    lowestPrice,
    holdSeconds,
    reason,
    id,
  );

  return getTradeById(id);
}

/**
 * Sell a portion of an open trade when a partial TP tier is hit.
 *
 * Records the fill and updates `filled_token_amount` /
 * `filled_sol_proceeds` on the trade row so future PnL
 * computations account for proceeds already banked.
 */
export function insertPartialFill(
  tradeId: number,
  tierIndex: number,
  tierPct: number,
  tierTargetPct: number,
  tokenAmount: number,
  solProceeds: number,
  priceSol: number | null,
  priceUsd: number | null,
): void {
  db.query(
    `INSERT INTO partial_fills(
        trade_id, ts, tier_index, tier_pct, tier_target_pct,
        token_amount, sol_proceeds, price_sol, price_usd
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    tradeId,
    Date.now(),
    tierIndex,
    tierPct,
    tierTargetPct,
    tokenAmount,
    solProceeds,
    priceSol,
    priceUsd,
  );

  db.query(
    `UPDATE trades
     SET filled_token_amount  = filled_token_amount + ?,
         filled_sol_proceeds  = filled_sol_proceeds + ?
     WHERE id = ?`,
  ).run(tokenAmount, solProceeds, tradeId);
}

/**
 * Returns the set of tier indices already filled for a trade.
 */
export function getFilledTierIndices(tradeId: number): Set<number> {
  const rows = db
    .query("SELECT DISTINCT tier_index FROM partial_fills WHERE trade_id = ?")
    .all(tradeId) as { tier_index: number }[];

  return new Set(rows.map((r) => r.tier_index));
}

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

export function deductWalletBalance(amountSol: number): void {
  const now = Date.now();
  db.query(
    `UPDATE wallet
     SET balance_sol = balance_sol - ?,
         equity_sol  = equity_sol - ?,
         updated_at  = ?
     WHERE id = 1`,
  ).run(amountSol, amountSol, now);
}

export function addWalletBalance(amountSol: number): void {
  const now = Date.now();
  db.query(
    `UPDATE wallet
     SET balance_sol = balance_sol + ?,
         equity_sol  = equity_sol + ?,
         updated_at  = ?
     WHERE id = 1`,
  ).run(amountSol, amountSol, now);
}

export function getWalletBalance(): number {
  const row = db
    .query("SELECT balance_sol FROM wallet WHERE id = 1")
    .get() as { balance_sol: number } | null;

  return row?.balance_sol ?? 0;
}

export function getOpenTradeCount(): number {
  const row = db
    .query("SELECT COUNT(*) AS c FROM trades WHERE open = 1")
    .get() as { c: number };

  return row?.c ?? 0;
}

// ---------------------------------------------------------------------------
// Snapshots & raw events
// ---------------------------------------------------------------------------

export function insertSnapshot(
  tradeId: number | null,
  mint: string,
  ts: number,
  data: Record<string, unknown>,
  rawJson: string,
): void {
  const n = (v: unknown): number | null =>
    v != null && typeof v === "number" ? v : null;
  const b = (v: unknown): number | null =>
    v != null && typeof v === "boolean" ? (v ? 1 : 0) : null;

  db.query(
    `INSERT INTO snapshots(
        trade_id, mint, ts,
        price_sol, price_usd, market_cap, holders,
        liquidity,
        buy_tx_1m, sell_tx_1m,
        buy_volume_1m, sell_volume_1m,
        buy_tx_5m, sell_tx_5m,
        buy_volume_5m, sell_volume_5m,
        buy_tx_1h, sell_tx_1h,
        buy_volume_1h, sell_volume_1h,
        price_change_1m, price_change_5m, price_change_1h,
        top10, dev_holdings,
        freeze_authority, mint_authority,
        raw_json
      )
      VALUES (?, ?, ?,
              ?, ?, ?, ?,
              ?,
              ?, ?,
              ?, ?,
              ?, ?,
              ?, ?,
              ?, ?,
              ?, ?,
              ?, ?, ?,
              ?, ?,
              ?, ?,
              ?)`,
  ).run(
    tradeId,
    mint,
    ts,

    n(data.tp),
    n(data.tpu),
    n(data.mp),
    n(data.h),

    n(data.cr),

    n(data.bt1m),
    n(data.st1m),

    n(data.bv1m),
    n(data.sv1m),

    n(data.bt5m),
    n(data.st5m),

    n(data.bv5m),
    n(data.sv5m),

    n(data.bt1h),
    n(data.st1h),

    n(data.bv1h),
    n(data.sv1h),

    n(data.pc1m),
    n(data.pc5m),
    n(data.pc1h),

    n(data.t10),
    n(data.dhp),

    b(data.fa),
    b(data.ma),

    rawJson,
  );
}

export function insertRawEvent(
  eventTs: number,
  eventType: string | null,
  mint: string | null,
  pair: string | null,
  payload: string,
): void {
  db.query(
    `INSERT INTO raw_events(event_ts, event_type, mint, pair, payload)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(eventTs, eventType, mint, pair, payload);
}
