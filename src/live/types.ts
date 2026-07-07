/**
 * Live-trading-specific type definitions.
 *
 * Mirrors the JSON shapes returned by the DBotX live trading API endpoints.
 * All types are prefixed with "Live" to distinguish them from simulator types.
 */
import type { ParsedSignal } from "../telegram/telegram_listener";

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

/** Wallet information returned by GET /account/wallets. */
export interface LiveWalletInfo {
  /** Wallet ID used in swap orders. */
  id: string;
  /** Human-friendly wallet name. */
  name: string;
  /** Wallet type — "solana" or "evm". */
  type: string;
  /** On-chain public address. */
  address: string;
  /** Number of parallel accounts (Solana). */
  nonceCount?: number;
  /** Whether nonce accounts have been initialised. */
  nonceInitilized?: boolean;
}

// ---------------------------------------------------------------------------
// Wallet balance
// ---------------------------------------------------------------------------

/** Response from GET /kline/wallet/balance. */
export interface LiveWalletBalanceResponse {
  err: boolean;
  res: {
    /** On-chain account address. */
    account: string;
    /** Raw amount as string. */
    amount: string;
    /** Human-readable balance (SOL/ETH/BNB). */
    uiAmount: number;
  };
}

/** Normalised wallet balance used by the bot. */
export interface LiveBalance {
  /** Usable balance in native coin (SOL). */
  balanceSol: number;
}

// ---------------------------------------------------------------------------
// Swap order
// ---------------------------------------------------------------------------

/** Trade direction for live swap orders. */
export type LiveTradeType = "buy" | "sell";

/** Lifecycle states for a swap order. */
export type LiveOrderState = "init" | "processing" | "done" | "fail" | "expired";

/** Response from POST /automation/swap_order (or WS createSwapOrder). */
export interface LiveSwapOrderResponse {
  err: boolean;
  res: {
    /** Order ID to track with swap_orders or WS getSwapOrder. */
    id: string;
  };
  docs?: string;
}

/** Individual swap order info from GET /automation/swap_orders or WS getSwapOrder. */
export interface LiveSwapOrderInfo {
  /** Order ID. */
  id: string;
  /** Current state. */
  state: LiveOrderState;
  /** Blockchain. */
  chain: string;
  /** Trade direction. */
  tradeType: LiveTradeType;
  /** Execution price in USD (present when state === "done"). */
  txPriceUsd?: number;
  /** On-chain transaction hash. */
  swapHash?: string;
  /** Transaction explorer link. */
  swapLink?: string;
  /** Error code on failure. */
  errorCode?: string;
  /** Human-readable error on failure. */
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// PnL (TP/SL) tasks
// ---------------------------------------------------------------------------

/** Response from GET /automation/pnl_orders_from_swap_order. */
export interface LivePnLTask {
  /** Task ID. */
  id: string;
  /** Whether the task is active. */
  enabled: boolean;
  /** Current state. */
  state: LiveOrderState;
  /** Blockchain. */
  chain: string;
  /** Always "sell" for TP/SL tasks. */
  tradeType: "sell";
  /** Buy price (USD) — baseline. */
  basePriceUsd: number;
  /** Trigger direction — "up" for TP, "down" for SL. */
  triggerDirection: "up" | "down";
  /** Trigger price in USD. */
  triggerPriceUsd: number;
  /** Actual TP/SL percentage (e.g., 0.22 = 22%). */
  triggerPercent: number;
  /** Execution price (USD) if triggered. */
  txPriceUsd?: number;
  /** Token contract address. */
  token: string;
  /** Trading pair address. */
  pair: string;
  /** DEX source. */
  pairType: string;
  /** Wallet ID that owns this task. */
  walletId: string;
  /** Source — always "swap_order" for our use case. */
  source: "swap_order";
  /** Originating swap order ID. */
  sourceId: string;
  /** Group index for partial TP/SL tiers (null if single). */
  sourceGroupIdx: number | null;
  /** Sell ratio (0-1). */
  currencyAmountUI: number;
  /** Expiry timestamp (ms). */
  expireAt: number;
  /** Whether to execute market sell on expiry. */
  expireExecute: boolean;
  /** Token metadata. */
  tokenInfo: {
    contract: string;
    name: string;
    symbol: string;
    decimals: number;
  };
  /** Jito anti-MEV enabled. */
  jitoEnabled: boolean;
  /** Jito tip amount. */
  jitoTip?: number;
  /** Max slippage tolerance. */
  maxSlippage: number;
  /** Error details on failure. */
  errorCode?: string;
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// WS trade result notification
// ---------------------------------------------------------------------------

/** Sub-source discriminator in WS trade result events. */
export type TradeResultSubSource =
  | "swap_take_profit"
  | "swap_stop_loss"
  | "swap_trailing_stop"
  | null;

/** Source discriminator in WS trade result events. */
export type TradeResultSource =
  | "swap_order"
  | "limit_order"
  | "trailing_stop_order"
  | "follow_order";

/** Shape of a WS tradeResultNotify event (all types). */
export interface TradeResultEvent {
  /** Always "tradeResultNotify". */
  method: "tradeResultNotify";
  result: {
    /** Task/order ID that was executed. */
    id: string;
    /** Execution state. */
    state: LiveOrderState;
    /** Source type identifying what created this order. */
    source: TradeResultSource;
    /** Sub-source for TP/SL/trailing events. */
    subSource: TradeResultSubSource;
    /** Blockchain. */
    chain: string;
    /** Block number (null on failure). */
    block: number | null;
    /** Transaction hash (null on failure). */
    hash: string | null;
    /** Order creation timestamp (ms). */
    createAt: number;
    /** Execution timestamp (s) (null on failure). */
    timestamp: number | null;
    /** Wallet address. */
    wallet: string;
    /** Transaction type — "buy" or "sell". */
    type: "buy" | "sell";
    /** Token contract address. */
    token: string;
    /** Trading pair address. */
    pair: string;
    /** Token symbol. */
    symbol: string;
    /** Sent token info (present on success). */
    send?: {
      info: { contract: string; name: string; symbol: string; decimals: number };
      amount: string;
    };
    /** Received token info (present on success). */
    receive?: {
      info: { contract: string; name: string; symbol: string; decimals: number };
      amount: string;
    };
    /** Execution price in USD (present on success). */
    priceUsd?: number;
    /** DBotX fee charged (present on success). */
    dbotFee?: string;
    /** Error code (present on failure). */
    errorCode?: string;
    /** Error message (present on failure). */
    errorMessage?: string;
  };
}

// ---------------------------------------------------------------------------
// Position domain types (shared with the rest of the live module)
// ---------------------------------------------------------------------------

/** Reasons a position can be closed. */
export type CloseReason =
  | "take_profit"
  | "stop_loss"
  | "trailing_stop"
  | "trailing_tp"
  | "expired"
  | "manual"
  | "pump_message"
  | "backstop_tp";

/** Lifecycle status of a position. */
export type PositionStatus = "open" | "closing" | "closed";

/**
 * Full state of a live trading position.
 *
 * Differs from the simulator equivalent in that TP/SL is server-managed,
 * so there is no local `tasks` map.  The remaining token balance is tracked
 * via the WS trade result events.
 */
export interface PositionState {
  /** Unique auto-increment position ID (used as the store key). */
  id: number;
  /** Live swap order ID from the create response. */
  orderId: string;
  /** Trading pair address (LP). */
  pair: string;
  /** Token contract address. */
  token: string;
  /** Human-readable token name. */
  tokenName: string;
  /** Token symbol. */
  tokenSymbol: string;
  /** Entry price in USD (set when swap order state becomes "done"). */
  entryPriceUsd: number | null;
  /** Position size in SOL. */
  sizeSol: number;
  /** Highest price reached since position was opened. */
  peakPriceUsd: number;
  /** Whether the trailing stop has been activated (price >= entry + activation%). */
  trailingActive: boolean;
  /** Current profit percentage (computed from latest pair price vs entry). */
  currentProfitPercent: number;
  /** Current profit in USD. */
  currentProfitUsd: number;
  /** Epoch timestamp (ms) when the position was opened. */
  openedAt: number;
  /** Epoch timestamp (ms) of base TTL expiration. */
  expiresAt: number;
  /** Epoch timestamp (ms) of the last state update. */
  lastUpdateAt: number;
  /** Current lifecycle status. */
  status: PositionStatus;
  /** Why the position was closed (null while open/closing). */
  closeReason: CloseReason | null;
  /** Actual exit price in USD (null if not yet captured). */
  exitPriceUsd: number | null;
  /** The parsed signal that triggered this position. */
  signal: ParsedSignal;
}

/** Events emitted during the position lifecycle. */
export interface PositionEvent {
  /** Type of lifecycle event. */
  type: "opened" | "updated" | "closing" | "closed";
  /** The position state at the time of the event. */
  position: PositionState;
  /** Reason for closure (only set when type is "closed"). */
  closeReason?: CloseReason;
  /** Optional human-readable detail. */
  detail?: string;
}
