import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { LIVE_CONFIG } from "../config";
import type { PositionState, CloseReason, PositionStatus } from "../../core/types";

export class LivePersistenceService {
  private db: Database | null = null;

  getDb(): Database {
    if (!this.db) {
      mkdirSync(dirname(LIVE_CONFIG.liveDbPath), { recursive: true });
      this.db = new Database(LIVE_CONFIG.liveDbPath, { create: true });
      this.db.run("PRAGMA journal_mode = WAL");
      this.db.run("PRAGMA synchronous = NORMAL");
      this.migrate();
    }
    return this.db;
  }

  savePosition(pos: PositionState): void {
    const db = this.getDb();
    db.prepare(`
      INSERT OR REPLACE INTO live_positions
        (id, order_id, pair, token, token_name, token_symbol,
         size_sol, filled_sol, avg_fill_price_usd,
         entry_price_usd, peak_price_usd, trailing_active,
         status, close_reason, exit_price_usd,
         current_profit_pct, current_profit_usd,
         opened_at, expires_at, last_update_at, signal_json, updated_at)
      VALUES
        ($id, $order_id, $pair, $token, $token_name, $token_symbol,
         $size_sol, $filled_sol, $avg_fill_price_usd,
         $entry_price_usd, $peak_price_usd, $trailing_active,
         $status, $close_reason, $exit_price_usd,
         $current_profit_pct, $current_profit_usd,
         $opened_at, $expires_at, $last_update_at, $signal_json,
         (unixepoch() * 1000))
    `).run({
      $id: pos.id,
      $order_id: pos.orderId,
      $pair: pos.pair,
      $token: pos.token,
      $token_name: pos.tokenName,
      $token_symbol: pos.tokenSymbol,
      $size_sol: pos.sizeSol,
      $filled_sol: pos.filledSol,
      $avg_fill_price_usd: pos.avgFillPriceUsd,
      $entry_price_usd: pos.entryPriceUsd,
      $peak_price_usd: pos.peakPriceUsd,
      $trailing_active: pos.trailingActive ? 1 : 0,
      $status: pos.status,
      $close_reason: pos.closeReason,
      $exit_price_usd: pos.exitPriceUsd,
      $current_profit_pct: pos.currentProfitPercent,
      $current_profit_usd: pos.currentProfitUsd,
      $opened_at: pos.openedAt,
      $expires_at: pos.expiresAt,
      $last_update_at: pos.lastUpdateAt,
      $signal_json: JSON.stringify(pos.signal),
    });
  }

  async loadNonClosed(): Promise<PositionState[]> {
    const db = this.getDb();
    const rows = db.prepare(
      "SELECT * FROM live_positions WHERE status IN ('open', 'closing')",
    ).all() as DbPositionRow[];
    return rows.map(this.rowToPosition);
  }

  loadAll(): PositionState[] {
    const db = this.getDb();
    return db.prepare("SELECT * FROM live_positions ORDER BY id").all()
      .map((r: any) => this.rowToPosition(r as DbPositionRow));
  }

  deletePosition(positionId: number): void {
    const db = this.getDb();
    db.prepare("DELETE FROM live_positions WHERE id = $id").run({ $id: positionId });
  }

  getAllOrderIds(): string[] {
    const db = this.getDb();
    const rows = db.prepare(
      "SELECT order_id FROM live_positions WHERE status IN ('open', 'closing')",
    ).all() as { order_id: string }[];
    return rows.map((r) => r.order_id);
  }

  saveDailyLoss(lossUsd: number): void {
    try {
      const db = this.getDb();
      const today = new Date().toISOString().slice(0, 10);
      db.prepare(`
        INSERT INTO live_daily_loss (date, loss_usd)
        VALUES ($date, $loss_usd)
        ON CONFLICT(date) DO UPDATE SET
          loss_usd = loss_usd + $loss_usd,
          updated_at = (unixepoch() * 1000)
      `).run({
        $date: today,
        $loss_usd: lossUsd > 0 ? lossUsd : 0,
      });
    } catch (err) {
      console.error("[live/persistence] Failed to persist daily loss:", err);
    }
  }

  loadDailyLoss(): number {
    try {
      const db = this.getDb();
      const today = new Date().toISOString().slice(0, 10);
      const row = db.prepare(
        "SELECT loss_usd FROM live_daily_loss WHERE date = $date",
      ).get({ $date: today }) as { loss_usd: number } | undefined;
      return row ? row.loss_usd : 0;
    } catch (err) {
      console.error("[live/persistence] Failed to load daily loss:", err);
      return 0;
    }
  }

  resetDailyLoss(): void {
    this.saveDailyLoss(0);
  }

  appendAuditLog(
    direction: "buy" | "sell",
    pair: string,
    amount: number | undefined,
    requestJson: string,
  ): number {
    const db = this.getDb();
    const result = db.prepare(`
      INSERT INTO live_audit_log (direction, pair, amount, status, request_json)
      VALUES ($direction, $pair, $amount, 'pending', $request_json)
    `).run({
      $direction: direction,
      $pair: pair,
      $amount: amount ?? null,
      $request_json: requestJson,
    });
    return Number(result.lastInsertRowid);
  }

  updateAuditLog(
    logId: number,
    status: string,
    orderId?: string,
    responseJson?: string,
    error?: string,
  ): void {
    const db = this.getDb();
    db.prepare(`
      UPDATE live_audit_log
      SET status = $status, order_id = $order_id,
          response_json = $response_json, error = $error,
          updated_at = (unixepoch() * 1000)
      WHERE id = $id
    `).run({
      $id: logId,
      $status: status,
      $order_id: orderId ?? null,
      $response_json: responseJson ?? null,
      $error: error ?? null,
    });
  }

  private migrate(): void {
    this.db!.exec(`
      CREATE TABLE IF NOT EXISTS live_positions (
        id INTEGER PRIMARY KEY,
        order_id TEXT NOT NULL UNIQUE,
        pair TEXT NOT NULL,
        token TEXT NOT NULL,
        token_name TEXT NOT NULL DEFAULT '',
        token_symbol TEXT NOT NULL DEFAULT '',
        size_sol REAL NOT NULL,
        filled_sol REAL DEFAULT 0,
        avg_fill_price_usd REAL,
        entry_price_usd REAL,
        peak_price_usd REAL DEFAULT 0,
        trailing_active INTEGER DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'open',
        close_reason TEXT,
        exit_price_usd REAL,
        current_profit_pct REAL DEFAULT 0,
        current_profit_usd REAL DEFAULT 0,
        opened_at INTEGER NOT NULL,
        expires_at INTEGER,
        last_update_at INTEGER NOT NULL,
        signal_json TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
      CREATE TABLE IF NOT EXISTS live_audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        direction TEXT NOT NULL,
        pair TEXT NOT NULL,
        amount REAL,
        status TEXT NOT NULL DEFAULT 'pending',
        order_id TEXT,
        request_json TEXT,
        response_json TEXT,
        error TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        updated_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS live_daily_loss (
        date TEXT PRIMARY KEY,
        loss_usd REAL NOT NULL DEFAULT 0,
        trade_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
    `);
    try { this.db!.run("ALTER TABLE live_positions ADD COLUMN filled_sol REAL DEFAULT 0"); } catch {}
    try { this.db!.run("ALTER TABLE live_positions ADD COLUMN avg_fill_price_usd REAL"); } catch {}
  }

  private rowToPosition(row: DbPositionRow): PositionState {
    let signal: any = {};
    if (row.signal_json) {
      try { signal = JSON.parse(row.signal_json); } catch {}
    }
    return {
      id: row.id,
      orderId: row.order_id,
      pair: row.pair,
      token: row.token,
      tokenName: row.token_name,
      tokenSymbol: row.token_symbol,
      entryPriceUsd: row.entry_price_usd,
      sizeSol: row.size_sol,
      filledSol: row.filled_sol ?? 0,
      avgFillPriceUsd: row.avg_fill_price_usd ?? null,
      entryCostUsd: null,
      peakPriceUsd: row.peak_price_usd,
      trailingActive: row.trailing_active === 1,
      currentProfitPercent: row.current_profit_pct,
      currentProfitUsd: row.current_profit_usd,
      tasks: new Map(),
      remainingBalance: "0",
      openedAt: row.opened_at,
      expiresAt: row.expires_at ?? row.opened_at,
      lastUpdateAt: row.last_update_at,
      status: row.status as PositionStatus,
      closeReason: row.close_reason as CloseReason | null,
      exitPriceUsd: row.exit_price_usd,
      signal: signal,
    };
  }
}

interface DbPositionRow {
  id: number;
  order_id: string;
  pair: string;
  token: string;
  token_name: string;
  token_symbol: string;
  size_sol: number;
  filled_sol: number;
  avg_fill_price_usd: number | null;
  entry_price_usd: number | null;
  peak_price_usd: number;
  trailing_active: number;
  status: string;
  close_reason: string | null;
  exit_price_usd: number | null;
  current_profit_pct: number;
  current_profit_usd: number;
  opened_at: number;
  expires_at: number | null;
  last_update_at: number;
  signal_json: string | null;
}
