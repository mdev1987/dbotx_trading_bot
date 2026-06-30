import { SQL } from "bun";
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

export const db = new SQL({
  adapter: "sqlite",
  filename: CONFIG.sqlitePath,
  create: true,
});

export async function initializeDatabase(): Promise<void> {
  await db`PRAGMA journal_mode = WAL;`;
  await db`PRAGMA busy_timeout = 5000;`;

  await db`
    CREATE TABLE IF NOT EXISTS wallet(
      id INTEGER PRIMARY KEY,
      balance_sol REAL NOT NULL,
      equity_sol REAL NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `;

  await db`
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
  `;

  await db`
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
  `;

  await db`
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
  `;

  await db`
    CREATE TABLE IF NOT EXISTS raw_events(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_ts INTEGER NOT NULL,
      event_type TEXT,
      mint TEXT,
      pair TEXT,
      payload TEXT NOT NULL
    )
  `;

  await db`
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
  `;

  await db`
    CREATE INDEX IF NOT EXISTS idx_trade_mint
    ON trades(mint)
  `;

  await db`
    CREATE INDEX IF NOT EXISTS idx_trade_open
    ON trades(open)
  `;

  await db`
    CREATE INDEX IF NOT EXISTS idx_snapshot_mint
    ON snapshots(mint)
  `;

  await db`
    CREATE INDEX IF NOT EXISTS idx_snapshot_ts
    ON snapshots(ts)
  `;

  await db`
    CREATE INDEX IF NOT EXISTS idx_snapshot_trade_id
    ON snapshots(trade_id)
  `;

  await db`
    CREATE INDEX IF NOT EXISTS idx_raw_events_mint
    ON raw_events(mint)
  `;

  await db`
    CREATE INDEX IF NOT EXISTS idx_raw_events_ts
    ON raw_events(event_ts)
  `;

  await db`
    CREATE INDEX IF NOT EXISTS idx_partial_fills_trade
    ON partial_fills(trade_id)
  `;

  /* ---- migrate legacy tables that may lack new columns ---- */
  const legacyCols: { name: string; def: string }[] = [
    { name: "filled_token_amount", def: "REAL NOT NULL DEFAULT 0" },
    { name: "filled_sol_proceeds", def: "REAL NOT NULL DEFAULT 0" },
    { name: "entry_market_cap", def: "REAL" },
    { name: "entry_liquidity", def: "REAL" },
  ];

  for (const col of legacyCols) {
    try {
      await db.unsafe(`ALTER TABLE trades ADD COLUMN ${col.name} ${col.def}`);
    } catch {
      /* column already exists – ignore */
    }
  }

  const [existing] = await db`SELECT COUNT(*) AS c FROM wallet` as { c: number }[];

  /* aggregate COUNT always returns a row */
  if (existing!.c === 0) {
    const now = Date.now();
    await db`
      INSERT INTO wallet(id, balance_sol, equity_sol, updated_at)
      VALUES (1, ${CONFIG.startingBalance}, ${CONFIG.startingBalance}, ${now})
    `;

    console.log(`[db] wallet initialised: ${CONFIG.startingBalance} SOL`);
  }
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export async function upsertToken(
  mint: string,
  pair: string | null,
  priceUsd: number | null,
  marketCap: number | null,
  liquidity: number | null,
  rawJson: string,
): Promise<void> {
  const now = Date.now();

  const [existing] = await db`
    SELECT first_price_usd FROM tokens WHERE mint = ${mint}
  ` as { first_price_usd: number | null }[];

  if (existing) {
    await db`
      UPDATE tokens
      SET last_seen = ${now},
          raw_json = ${rawJson}
      WHERE mint = ${mint}
    `;
  } else {
    await db`
      INSERT INTO tokens(mint, pair, first_seen, last_seen,
                          first_price_usd, first_market_cap,
                          first_liquidity, raw_json)
      VALUES (${mint}, ${pair}, ${now}, ${now},
              ${priceUsd}, ${marketCap},
              ${liquidity}, ${rawJson})
    `;
  }
}

// ---------------------------------------------------------------------------
// Trades
// ---------------------------------------------------------------------------

export async function insertTrade(
  mint: string,
  pair: string | null,
  priceSol: number | null,
  priceUsd: number | null,
  amountSol: number,
  tokenAmount: number,
  ttlSeconds: number,
  rawJson: string,
  entryMarketCap: number | null,
  entryLiquidity: number | null,
): Promise<TradeRow> {
  const now = Date.now();

  const [info] = await db`
    INSERT INTO trades(
        mint, pair, entry_ts, ttl_seconds,
        entry_price_sol, entry_price_usd,
        amount_sol, token_amount,
        filled_token_amount, filled_sol_proceeds,
        entry_market_cap, entry_liquidity,
        open, raw_entry_json
      )
      VALUES (${mint}, ${pair}, ${now}, ${ttlSeconds},
              ${priceSol}, ${priceUsd},
              ${amountSol}, ${tokenAmount},
              0, 0,
              ${entryMarketCap}, ${entryLiquidity},
              1, ${rawJson})
      RETURNING *
  ` as TradeRow[];

  /* RETURNING * always returns the inserted row */
  return info!;
}

export async function getOpenTrades(): Promise<TradeRow[]> {
  return await db`
    SELECT * FROM trades
    WHERE open = 1
    ORDER BY entry_ts ASC
  ` as TradeRow[];
}

export async function getTradeById(id: number): Promise<TradeRow | null> {
  const [trade] = await db`
    SELECT * FROM trades WHERE id = ${id}
  ` as TradeRow[];
  return trade ?? null;
}

export async function getLatestSnapshot(mint: string): Promise<SnapshotRow | null> {
  const [snap] = await db`
    SELECT * FROM snapshots
    WHERE mint = ${mint}
    ORDER BY ts DESC
    LIMIT 1
  ` as SnapshotRow[];
  return snap ?? null;
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

export async function updateTradePnL(
  id: number,
  priceSol: number | null,
  priceUsd: number | null,
): Promise<void> {
  const trade = await getTradeById(id);
  if (!trade) return;

  const isFirstPrice = trade.token_amount === 0 && priceSol !== null && priceSol > 0;

  /* initialise token_amount when the first price arrives */
  if (isFirstPrice) {
    const newTokenAmount = trade.amount_sol / priceSol;
    await db`UPDATE trades SET token_amount = ${newTokenAmount} WHERE id = ${id}`;
    trade.token_amount = newTokenAmount;

    /* capture entry snapshot data – market cap and liquidity at first price */
    const snap = await getLatestSnapshot(trade.mint);
    if (snap) {
      await db`
        UPDATE trades
        SET entry_snapshot_id = ${snap.id},
            entry_market_cap = ${snap.market_cap},
            entry_liquidity = ${snap.liquidity}
        WHERE id = ${id}
      `;
    }
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

  await db`
    UPDATE trades
    SET entry_price_sol    = COALESCE(entry_price_sol, ${priceSol}),
        entry_price_usd    = COALESCE(entry_price_usd, ${priceUsd}),
        pnl_sol            = ${pnlSol},
        pnl_percent        = ${pnlPercent},
        highest_price      = ${highestPrice},
        lowest_price       = ${lowestPrice}
    WHERE id = ${id}
  `;

  /* keep wallet equity in sync with latest market prices */
  await recalculateWalletEquity();
}

/**
 * Close the remaining position of an open trade.
 *
 * Sells `token_amount - filled_token_amount` tokens at
 * `priceSol` and records the final PnL including all
 * prior partial-fill proceeds.
 */
export async function closeTrade(
  id: number,
  priceSol: number | null,
  priceUsd: number | null,
  reason: ExitReason,
): Promise<TradeRow | null> {
  const trade = await getTradeById(id);
  if (!trade || !trade.open) return null;

  const now = Date.now();
  const holdSeconds = Math.floor((now - trade.entry_ts) / 1000);

  let { pnlSol, pnlPercent } = computePnL(trade, priceSol);

  /* exiting actual price equals the argument for remaining fill */
  let exitPriceSol: number | null = priceSol;
  let exitPriceUsd: number | null = priceUsd;

  /* if we lacked a live price, fall back to last snapshot */
  if (exitPriceSol === null) {
    const snap = await getLatestSnapshot(trade.mint);
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

  await db`
    UPDATE trades
    SET exit_ts          = ${now},
        exit_price_sol   = ${exitPriceSol},
        exit_price_usd   = ${exitPriceUsd},
        pnl_sol          = ${pnlSol},
        pnl_percent      = ${pnlPercent},
        highest_price    = ${highestPrice},
        lowest_price     = ${lowestPrice},
        hold_seconds     = ${holdSeconds},
        exit_reason      = ${reason},
        open             = 0
    WHERE id = ${id}
  `;

  const closed = await getTradeById(id);

  /* wallet equity is only cash after close (no open positions) */
  await recalculateWalletEquity();

  return closed;
}

/**
 * Sell a portion of an open trade when a partial TP tier is hit.
 *
 * Records the fill and updates `filled_token_amount` /
 * `filled_sol_proceeds` on the trade row so future PnL
 * computations account for proceeds already banked.
 */
export async function insertPartialFill(
  tradeId: number,
  tierIndex: number,
  tierPct: number,
  tierTargetPct: number,
  tokenAmount: number,
  solProceeds: number,
  priceSol: number | null,
  priceUsd: number | null,
): Promise<void> {
  await db`
    INSERT INTO partial_fills(
        trade_id, ts, tier_index, tier_pct, tier_target_pct,
        token_amount, sol_proceeds, price_sol, price_usd
      )
      VALUES (${tradeId}, ${Date.now()}, ${tierIndex}, ${tierPct}, ${tierTargetPct},
              ${tokenAmount}, ${solProceeds}, ${priceSol}, ${priceUsd})
  `;

  await db`
    UPDATE trades
    SET filled_token_amount  = filled_token_amount + ${tokenAmount},
        filled_sol_proceeds  = filled_sol_proceeds + ${solProceeds}
    WHERE id = ${tradeId}
  `;
}

/**
 * Returns the set of tier indices already filled for a trade.
 */
export async function getFilledTierIndices(tradeId: number): Promise<Set<number>> {
  const rows = await db`
    SELECT DISTINCT tier_index FROM partial_fills WHERE trade_id = ${tradeId}
  ` as { tier_index: number }[];

  return new Set(rows.map((r) => r.tier_index));
}

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

export async function deductWalletBalance(amountSol: number): Promise<void> {
  const now = Date.now();
  await db`
    UPDATE wallet
    SET balance_sol = balance_sol - ${amountSol},
        updated_at  = ${now}
    WHERE id = 1
  `;
}

export async function addWalletBalance(amountSol: number): Promise<void> {
  const now = Date.now();
  await db`
    UPDATE wallet
    SET balance_sol = balance_sol + ${amountSol},
        updated_at  = ${now}
    WHERE id = 1
  `;
}

/**
 * Recompute wallet equity as cash balance + current market value
 * of all open positions. Called after every price update or trade
 * lifecycle event so the equity column always reflects real
 * mark-to-market value.
 */
export async function recalculateWalletEquity(): Promise<void> {
  const [wallet] = await db`
    SELECT balance_sol FROM wallet WHERE id = 1
  ` as { balance_sol: number }[];

  if (!wallet) return;

  /*
   * Fetch all open trades with their latest snapshot price
   * in a single query to avoid N+1.
   */
  const openTrades = await db`
    SELECT
       t.id,
       t.amount_sol,
       t.token_amount,
       t.filled_token_amount,
       t.filled_sol_proceeds,
       t.entry_price_sol,
       COALESCE(s.price_sol, t.entry_price_sol) AS current_price
     FROM trades t
     LEFT JOIN (
       SELECT mint, MAX(ts) AS max_ts
       FROM snapshots
       GROUP BY mint
     ) latest ON latest.mint = t.mint
     LEFT JOIN snapshots s
       ON s.mint = t.mint AND s.ts = latest.max_ts
     WHERE t.open = 1
  ` as {
    id: number;
    amount_sol: number;
    token_amount: number;
    filled_token_amount: number;
    filled_sol_proceeds: number;
    entry_price_sol: number | null;
    current_price: number | null;
  }[];

  let openValue = 0;

  for (const trade of openTrades) {
    const remaining = trade.token_amount - trade.filled_token_amount;
    if (remaining <= 0) continue;

    if (trade.current_price !== null && trade.current_price > 0 && trade.token_amount > 0) {
      openValue += remaining * trade.current_price + trade.filled_sol_proceeds;
    } else if (trade.entry_price_sol !== null && trade.entry_price_sol > 0) {
      openValue += remaining * trade.entry_price_sol + trade.filled_sol_proceeds;
    } else {
      openValue += trade.amount_sol;
    }
  }

  const equity = wallet.balance_sol + openValue;
  await db`
    UPDATE wallet SET equity_sol = ${equity}, updated_at = ${Date.now()} WHERE id = 1
  `;
}

export async function getWalletBalance(): Promise<number> {
  const [row] = await db`
    SELECT balance_sol FROM wallet WHERE id = 1
  ` as { balance_sol: number }[];

  return row?.balance_sol ?? 0;
}

export async function getOpenTradeCount(): Promise<number> {
  const [row] = await db`
    SELECT COUNT(*) AS c FROM trades WHERE open = 1
  ` as { c: number }[];

  return row?.c ?? 0;
}

// ---------------------------------------------------------------------------
// Snapshots & raw events
// ---------------------------------------------------------------------------

export async function insertSnapshot(
  tradeId: number | null,
  mint: string,
  ts: number,
  data: Record<string, unknown>,
  rawJson: string,
): Promise<void> {
  const n = (v: unknown): number | null =>
    v != null && typeof v === "number" ? v : null;
  const b = (v: unknown): number | null =>
    v != null && typeof v === "boolean" ? (v ? 1 : 0) : null;

  await db`
    INSERT INTO snapshots(
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
      VALUES (
        ${tradeId}, ${mint}, ${ts},
        ${n(data.tp)}, ${n(data.tpu)}, ${n(data.mp)}, ${n(data.h)},
        ${n(data.cr)},
        ${n(data.bt1m)}, ${n(data.st1m)},
        ${n(data.bv1m)}, ${n(data.sv1m)},
        ${n(data.bt5m)}, ${n(data.st5m)},
        ${n(data.bv5m)}, ${n(data.sv5m)},
        ${n(data.bt1h)}, ${n(data.st1h)},
        ${n(data.bv1h)}, ${n(data.sv1h)},
        ${n(data.pc1m)}, ${n(data.pc5m)}, ${n(data.pc1h)},
        ${n(data.t10)}, ${n(data.dhp)},
        ${b(data.fa)}, ${b(data.ma)},
        ${rawJson}
      )
  `;
}

export async function insertRawEvent(
  eventTs: number,
  eventType: string | null,
  mint: string | null,
  pair: string | null,
  payload: string,
): Promise<void> {
  await db`
    INSERT INTO raw_events(event_ts, event_type, mint, pair, payload)
    VALUES (${eventTs}, ${eventType}, ${mint}, ${pair}, ${payload})
  `;
}
