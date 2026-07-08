/**
 * Structure of a market data update for a trading pair
 */
export interface PairUpdate {
  /** LP address or pair identifier */
  pair: string;
  /** Token contract address */
  token?: string;
  /** Current price in USD */
  priceUsd?: number;
  /** Market cap in USD */
  marketCapUsd?: number;
  /** Liquidity in USD */
  liquidityUsd?: number;
  /** Number of token holders */
  holders?: number;
  /** Update timestamp (milliseconds) */
  timestamp: number;
  /** Raw parsed message for debugging */
  raw: unknown;
}

/**
 * A single item inside a pairsInfo WS result array.
 * Identifies the pair via `p` and carries price data in `tpu`/`tp`.
 */
export interface PairsInfoResultItem {
  p: string;
  tpu?: unknown;
  tp?: unknown;
  mp?: unknown;
  h?: number;
  t10?: number;
  [key: string]: unknown;
}

/**
 * Shape of an incoming raw WebSocket JSON message from the DBotX API.
 *
 * The `result` field can be either a single object (ack / pairInfo / tx)
 * or an array of per-pair objects (pairsInfo).
 */
export interface WsRawMessage {
  /** Message status (e.g., "ack", "ok") */
  status?: string;
  /** Message type (e.g., "pairInfo", "pairsInfo", "tx") */
  type?: string;
  /** Pair identifier */
  pair?: string;
  /** Token contract address */
  token?: string;
  /** Price value (may be string or number) */
  priceUsd?: unknown;
  /** Market cap value */
  marketCapUsd?: unknown;
  /** Liquidity value */
  liquidityUsd?: unknown;
  /** Holders count */
  holders?: unknown;
  /** Server timestamp */
  t?: number;
  /**
   * Payload — either a single object (pairInfo / tx / ack) or
   * an array of per-pair objects (pairsInfo).
   */
  result?: Record<string, unknown> | PairsInfoResultItem[];
}
