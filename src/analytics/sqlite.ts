/**
 * analytics/sqlite.ts
 *
 * Bun SQLite database singleton for position/task persistence.
 *
 * Tables are created via migration on first access (WAL mode).
 * Use getDb() to obtain the shared Database instance.
 */

import { Database } from "bun:sqlite";
import { CONFIG } from "../config";
import { mkdirSync } from "fs";
import { dirname } from "path";

let _db: Database | null = null;

export function getDb(): Database {
  if (!_db) {
    mkdirSync(dirname(CONFIG.sqlitePath), { recursive: true });
    _db = new Database(CONFIG.sqlitePath, { create: true });
    _db.exec("PRAGMA journal_mode = WAL");
    _db.exec("PRAGMA synchronous = NORMAL");
    migrate(_db);
  }
  return _db;
}

function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS positions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id      TEXT    NOT NULL UNIQUE,
      pair          TEXT    NOT NULL,
      token         TEXT    NOT NULL,
      token_name    TEXT    NOT NULL,
      entry_price   REAL,
      entry_cost    REAL,
      size_sol      REAL    NOT NULL,
      peak_price    REAL,
      close_reason  TEXT,
      profit_pct    REAL,
      profit_usd    REAL,
      opened_at     INTEGER NOT NULL,
      closed_at     INTEGER,
      signal_json   TEXT,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id     INTEGER NOT NULL REFERENCES positions(id),
      group_idx       INTEGER NOT NULL,
      state           TEXT    NOT NULL,
      trigger_price   REAL,
      base_price      REAL,
      amount_pct      REAL,
      pnl_pct         REAL,
      updated_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    CREATE INDEX IF NOT EXISTS idx_positions_order_id ON positions(order_id);
    CREATE INDEX IF NOT EXISTS idx_positions_closed_at ON positions(closed_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_position_id ON tasks(position_id);
  `);
}
