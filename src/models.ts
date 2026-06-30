/**
 * DBotX WebSocket message types and internal data models.
 *
 * Every incoming message is stored as raw JSON before any
 * normalization, ensuring no fields are lost when DBotX
 * adds new properties.
 */

// ---------------------------------------------------------------------------
// DBotX wire protocol
// ---------------------------------------------------------------------------

/** Acknowledgement sent by DBotX after a successful subscription. */
export interface DbotxSubscribeAck {
  status: "ack";
  method?: string;
  result: {
    t: number;
    subscribed: string[];
    message: string;
  };
}

/**
 * Payload of a `newPairInfo` message – fired when a brand-new
 * trading pair is created on a DEX that DBotX monitors.
 *
 * Field names are DBotX's short codes:
 *   p  – pair address
 *   m  – token mint
 *   s  – symbol
 *   n  – name
 *   pt – pool type (e.g. "pump")
 *   sl – initial liquidity in SOL lamports
 *   ca – created timestamp (milliseconds)
 *   da – deployer address
 *   ipm – immutable (mint authority disabled)
 *   ita – freeze authority disabled
 *   im  – token image URL
 */
export interface DbotxNewPairInfo {
  type: "newPairInfo";
  result: {
    p: string;
    m: string;
    s: string;
    n: string;
    pt: string;
    sl: number;
    ca: number;
    da: string;
    ipm: boolean;
    ita: boolean;
    im?: string;
    [key: string]: unknown;
  };
}

/**
 * Per-pair real-time snapshot delivered by the `pairInfo` subscription.
 *
 * @see https://docs.dbotx.com for field definitions.
 */
export interface PairInfoResult {
  t10: number;
  fa: boolean;
  ma: boolean;
  dhp: number;
  tf: number;
  h: number;
  im?: string;

  /** Token price in SOL. */
  tp: number;

  /** Token price in USD. */
  tpu: number;

  /** Market cap in USD. */
  mp: number;

  /** Token reserve. */
  tr: number;

  /** SOL reserve. */
  sr: number;

  /** Current reserve / liquidity in SOL. */
  cr: number;

  bt1m: number;
  st1m: number;
  bv1m: number;
  sv1m: number;

  bt5m: number;
  st5m: number;
  bv5m: number;
  sv5m: number;

  bt1h: number;
  st1h: number;
  bv1h: number;
  sv1h: number;

  pc1m: number;
  pc5m: number;
  pc1h: number;

  [key: string]: unknown;
}

export interface DbotxPairInfo {
  type: "pairInfo";
  result: PairInfoResult;
}

/** Union of every message type the client can receive. */
export type DbotxMessage =
  | DbotxSubscribeAck
  | DbotxNewPairInfo
  | DbotxPairInfo
  | Record<string, unknown>;

// ---------------------------------------------------------------------------
// Internal row shapes
// ---------------------------------------------------------------------------

export interface WalletRow {
  id: number;
  balance_sol: number;
  equity_sol: number;
  updated_at: number;
}

export interface TokenRow {
  mint: string;
  pair: string | null;
  first_seen: number;
  last_seen: number;
  first_price_usd: number | null;
  first_market_cap: number | null;
  first_liquidity: number | null;
  raw_json: string;
}

export interface TradeRow {
  id: number;
  mint: string;
  pair: string | null;
  entry_ts: number;
  exit_ts: number | null;
  ttl_seconds: number;
  entry_price_sol: number | null;
  entry_price_usd: number | null;
  exit_price_sol: number | null;
  exit_price_usd: number | null;
  amount_sol: number;
  token_amount: number;
  filled_token_amount: number;
  filled_sol_proceeds: number;
  pnl_sol: number | null;
  pnl_percent: number | null;
  highest_price: number | null;
  lowest_price: number | null;
  hold_seconds: number | null;
  exit_reason: string | null;
  open: number;
  entry_snapshot_id: number | null;
  raw_entry_json: string | null;
  raw_exit_json: string | null;
}

export interface SnapshotRow {
  id: number;
  trade_id: number | null;
  mint: string;
  ts: number;
  price_sol: number | null;
  price_usd: number | null;
  market_cap: number | null;
  holders: number | null;
  liquidity: number | null;
  buy_tx_1m: number | null;
  sell_tx_1m: number | null;
  buy_volume_1m: number | null;
  sell_volume_1m: number | null;
  buy_tx_5m: number | null;
  sell_tx_5m: number | null;
  buy_volume_5m: number | null;
  sell_volume_5m: number | null;
  buy_tx_1h: number | null;
  sell_tx_1h: number | null;
  buy_volume_1h: number | null;
  sell_volume_1h: number | null;
  price_change_1m: number | null;
  price_change_5m: number | null;
  price_change_1h: number | null;
  top10: number | null;
  dev_holdings: number | null;
  freeze_authority: number | null;
  mint_authority: number | null;
  raw_json: string;
}

export interface PartialFillRow {
  id: number;
  trade_id: number;
  ts: number;
  tier_index: number;
  tier_pct: number;
  tier_target_pct: number;
  token_amount: number;
  sol_proceeds: number;
  price_sol: number | null;
  price_usd: number | null;
}

export interface PartialTpTier {
  /** Fraction of original position to sell (e.g. 0.30 for 30%). */
  pct: number;
  /** PnL fraction that triggers this tier (e.g. 0.20 for +20%). */
  at: number;
}

export type ExitReason =
  | "TTL"
  | "TAKE_PROFIT"
  | "STOP_LOSS"
  | "TRAILING_STOP"
  | "SLIPPAGE"
  | "MANUAL";
