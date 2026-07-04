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
 * Shape of an incoming raw WebSocket JSON message from the DBotX API
 */
export interface WsRawMessage {
  /** Message status (e.g., "ack", "ok") */
  status?: string;
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
   * Alternative data wrapper used in some messages
   */
  result?: {
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
  };
}
