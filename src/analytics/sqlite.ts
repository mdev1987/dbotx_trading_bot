// Bun SQLite database singleton for position/task persistence
import { Database } from "bun:sqlite"; // Bun's built-in SQLite driver
import { CONFIG } from "../config"; // App configuration for DB path
import { mkdirSync } from "fs"; // Filesystem mkdir for ensuring directory exists
import { dirname } from "path"; // Path utility for extracting parent directory

/** Singleton database instance (null before first initialization) */
let _db: Database | null = null;

/**
 * Get (or create on first call) the shared SQLite database instance
 * @returns The initialized Database instance
 */
export function getDb(): Database {
  // Lazy initialization on first access
  if (!_db) {
    // Ensure the directory for the SQLite file exists
    mkdirSync(dirname(CONFIG.sqlitePath), { recursive: true });
    // Open or create the database file
    _db = new Database(CONFIG.sqlitePath, { create: true });
    // Enable WAL mode for better concurrent read performance
    _db.run("PRAGMA journal_mode = WAL");
    // Use NORMAL synchronous mode (balance safety vs performance)
    _db.run("PRAGMA synchronous = NORMAL");

    // If configured to clear analytics on start, drop existing tables
    if (CONFIG.clearAnalyticsOnStart) {
      console.log(
        "[sqlite] Clearing analytics data (CLEAR_ANALYTICS_ON_START=true)",
      );
      _db.run("DROP TABLE IF EXISTS tasks");
      _db.run("DROP TABLE IF EXISTS positions");
    }

    // Run migrations to ensure tables exist
    migrate(_db);
  }
  // Return the initialized instance
  return _db;
}

/**
 * Create tables and indexes if they don't already exist
 * @param db - The database instance to migrate
 */
function migrate(db: Database): void {
  // Execute migration SQL: create positions + tasks tables and supporting indexes
  db.exec(`
    -- Main positions table tracking trade lifecycle
    CREATE TABLE IF NOT EXISTS positions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,  -- Auto-incrementing row ID
      order_id      TEXT    NOT NULL UNIQUE,             -- Simulator order ID (unique)
      pair          TEXT    NOT NULL,                    -- Trading pair (LP address)
      token         TEXT    NOT NULL,                    -- Token contract address
      token_name    TEXT    NOT NULL,                    -- Human-readable token name
      entry_price   REAL,                               -- Entry price in USD
      entry_cost    REAL,                                -- Total cost of entry in USD
      size_sol      REAL    NOT NULL,                    -- Position size in SOL
      peak_price    REAL,                                -- Peak price reached during position
      close_reason  TEXT,                                -- Reason position was closed
      profit_pct    REAL,                                -- Profit/loss as percentage
      profit_usd    REAL,                                -- Profit/loss in USD
      opened_at     INTEGER NOT NULL,                    -- Timestamp when position opened (ms)
      closed_at     INTEGER,                             -- Timestamp when position closed (ms)
      signal_json   TEXT,                                -- Full signal JSON for reference
      created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000)  -- Row creation timestamp
    );

    -- Tasks table for TP/SL sub-orders associated with a position
    CREATE TABLE IF NOT EXISTS tasks (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,  -- Auto-incrementing row ID
      position_id     INTEGER NOT NULL REFERENCES positions(id),  -- FK to positions table
      group_idx       INTEGER NOT NULL,                  -- Index within the profit/loss group
      state           TEXT    NOT NULL,                   -- Task state: init, done, fail, expired
      trigger_price   REAL,                               -- Price that triggers this task
      base_price      REAL,                               -- Base price (entry) for this task
      amount_pct      REAL,                               -- Fraction of position allocated
      pnl_pct         REAL,                               -- PnL percentage for this task
      updated_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000)  -- Last update timestamp
    );

    -- Index for fast lookup by order ID
    CREATE INDEX IF NOT EXISTS idx_positions_order_id ON positions(order_id);
    -- Index for querying positions by closed date range
    CREATE INDEX IF NOT EXISTS idx_positions_closed_at ON positions(closed_at);
    -- Index for fast task lookups by parent position
    CREATE INDEX IF NOT EXISTS idx_tasks_position_id ON tasks(position_id);
  `);
}
