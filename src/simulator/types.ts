// API response types — mirrors JSON shapes from servapi.dbotx.com simulator endpoints

import type { ParsedSignal } from "../telegram/telegram_listener";  // Parsed signal type used in PositionState
import { CONFIG } from "../config";  // Application configuration singleton for default values

/**
 * Token information from the simulator API
 */
export interface SimTokenInfo {
  /** Token contract address */
  contract: string;
  /** Human-readable token name */
  name: string;
  /** Token ticker symbol */
  symbol: string;
  /** Number of decimal places */
  decimals: number;
  /** Optional URL to token icon */
  icon?: string;
  /** Total token supply (string to preserve precision), null if unknown */
  totalSupply: string | null;
  /** Authority allowed to mint new tokens, null if revoked */
  mintAuthority: string | null;
  /** Authority allowed to freeze token accounts, null if revoked */
  freezeAuthority: string | null;
  /** Token creation timestamp, null if unavailable */
  createAt: number | null;
}

/**
 * Currency (quote) information from the simulator API
 */
export interface SimCurrencyInfo {
  /** Quote token contract address */
  contract: string;
  /** Human-readable token name */
  name: string;
  /** Token ticker symbol */
  symbol: string;
  /** Number of decimal places */
  decimals: number;
  /** Optional URL to token icon */
  icon?: string;
  /** Total token supply (string to preserve precision), null if unknown */
  totalSupply: string | null;
  /** Token creation timestamp, null if unavailable */
  createAt: number | null;
}

/**
 * A TP/SL task created by the simulator for a swap order
 */
export interface PnLTask {
  /** Unique object ID from the database */
  _id: string;
  /** Simulator account ID that owns this task */
  accountId: string;
  /** Whether this task is currently active */
  enabled: boolean;
  /** Blockchain name (e.g., "solana") */
  chain: string;
  /** Type of trading pair */
  pairType: string;
  /** LP address / pair identifier */
  pair: string;
  /** Token contract address */
  token: string;
  /** Metadata of the traded token */
  tokenInfo: SimTokenInfo;
  /** Quote currency contract address */
  currency: string;
  /** Metadata of the quote currency */
  currencyInfo: SimCurrencyInfo;
  /** Wallet ID executing the swap, null if unset */
  walletId: string | null;
  /** Trade direction — always "sell" for TP/SL tasks */
  tradeType: "sell";
  /** Direction price must move to trigger ("up" for TP, "down" for SL) */
  triggerDirection: "up" | "down";
  /** USD price at which this task triggers */
  triggerPriceUsd: number;
  /** Amount of currency to sell (UI units) */
  currencyAmountUI: number;
  /** Epoch timestamp (seconds) when this task expires */
  expireAt: number;
  /** Delta in seconds from creation to expiry */
  expireDelta: number;
  /** Whether to execute the swap when the task expires */
  expireExecute: boolean;
  /** Whether to use mid-price instead of last-trade for trigger checks */
  useMidPrice: boolean;
  /** Originating system — always "swap_order" for position tasks */
  source: "swap_order";
  /** ID of the originating swap order */
  sourceId: string;
  /** ID of the originating trade within the swap order */
  sourceTradeId: string;
  /** Group index within the originating order (for partial TP tiers) */
  sourceGroupIdx: number;
  /** USD price at the time of task creation (baseline) */
  basePriceUsd: number;
  /** Initial PnL percentage at creation */
  initPnlPercent: number;
  /** Maximum allowed slippage fraction for the swap */
  maxSlippage: number;
  /** Priority fee string for transaction execution */
  priorityFee: string;
  /** Current lifecycle state of the task */
  state: "init" | "done" | "fail" | "expired";
  /** Epoch timestamp (ms) of the last state transition */
  lastStateUpdateAt: number;
  /** Epoch timestamp (ms) of task creation */
  createAt: number;
  /** Epoch timestamp (ms) of last update */
  updateAt: number;
  /** Machine-readable error code if the task failed */
  errorCode: string;
  /** Human-readable error message if the task failed */
  errorMessage: string;
  /** Trigger percentage value (fraction, e.g. 0.05 = 5%) */
  triggerPercent: number;
}

/**
 * A trade pair representing an open position in the simulator
 */
export interface TradePair {
  /** Unique object ID from the database */
  _id: string;
  /** Blockchain name (e.g., "solana") */
  chain: string;
  /** Metadata of the base token being traded */
  tokenInfo0: SimTokenInfo;
  /** Metadata of the quote currency */
  tokenInfo1: SimCurrencyInfo;
  /** Balance of the base token (string to preserve precision) */
  token0Balance: string;
  /** Total cost of the position in USD */
  costUsd: number;
  /** Direction of the most recent trade on this pair */
  lastTradeType: "buy" | "sell";
  /** Epoch timestamp (ms) of the last trade */
  lastTradeTime: number;
  /** Amount of token purchased (string for precision) */
  buyTokenAmount: string;
  /** Cost of the buy side in USD */
  buyCostUsd: number;
  /** Amount of token sold (string for precision) */
  sellTokenAmount: string;
  /** Proceeds from the sell side in USD */
  sellReceiveUsd: number;
  /** Profit percent from the sell side only, null if no sell yet */
  sellProfitPercent: number | null;
  /** Profit USD from the sell side only, null if no sell yet */
  sellProfitUsd: number | null;
  /** Total profit percent across all trades */
  fullProfitPercent: number;
  /** Total profit in USD across all trades */
  fullProfitUsd: number;
  /** External links for charting and dex data */
  links: { dexscreener: string; uniswap: string };
}

/**
 * A single trade record from the simulator history
 */
export interface TradeRecord {
  /** Unique object ID from the database */
  _id: string;
  /** Application-level trade ID (may match _id) */
  id: string;
  /** Originating system — always "swap_order" for simulator trades */
  source: "swap_order";
  /** Optional sub-source label (e.g., "partial_tp") */
  subSource: string | null;
  /** Blockchain name (e.g., "solana") */
  chain: string;
  /** LP address / pair identifier */
  pair: string;
  /** Epoch timestamp (ms) of the trade */
  timestamp: number;
  /** Epoch timestamp (ms) of record creation */
  createAt: number;
  /** Trade direction */
  type: "buy" | "sell";
  /** Total notional value in USD */
  totalUsd: number;
  /** Token sent in the swap (quote for buy, base for sell) */
  sendToken: { info: SimCurrencyInfo; amount: string };
  /** Token received in the swap (base for buy, quote for sell) */
  receiveToken: { info: SimTokenInfo; amount: string };
  /** Tax / fee rate applied to the trade */
  taxRate: number;
  /** Tax / fee amount (string for precision) */
  taxAmount: string;
  /** Execution price in USD */
  priceUsd: number;
  /** Token balance snapshot after the trade */
  token: { info: SimTokenInfo; balance: string };
  /** Total fees paid in USD */
  totalFeeUsd: number;
  /** External links for charting and dex data */
  links: { dexscreener: string; uniswap: string };
}

/**
 * Generic API response wrapper for simulator endpoints
 *
 * All simulator API calls return this shape. The `err` field indicates
 * whether the request failed, and the payload (if successful) lives in `res`.
 */
interface SimApiResponse<T> {
  /** Whether the API call returned an error */
  err: boolean;
  /** Response payload (typed) */
  res: T;
  /** Optional documentation link on error */
  docs?: string;
}

// ──────────────────────────────────────────
// Domain types
// ──────────────────────────────────────────

/**
 * Snapshot of a single TP/SL task at a point in time
 */
export interface PnLTaskSnapshot {
  /** Group index within the swap order (matches sourceGroupIdx) */
  groupIdx: number;
  /** Current lifecycle state of the task */
  state: "init" | "done" | "fail" | "expired";
  /** USD price at which this task triggers */
  triggerPriceUsd: number;
  /** USD price at the time of task creation (baseline) */
  basePriceUsd: number;
  /** Fraction of the position allocated to this tier */
  amountPercent: number;
  /** Current PnL percentage for this task */
  pnlPercent: number;
}

/**
 * Reasons a position can be closed
 */
export type CloseReason =
  | "take_profit"
  | "stop_loss"
  | "trailing_stop"
  | "expired"
  | "manual"
  | "pump_message";

/**
 * Lifecycle status of a position
 */
export type PositionStatus = "open" | "closing" | "closed";

/**
 * Full state of a trading position
 */
export interface PositionState {
  /** Unique auto-increment position ID (used as the store key) */
  id: number;
  /** Simulator order ID associated with this position */
  orderId: string;
  /** LP address / pair identifier */
  pair: string;
  /** Token contract address */
  token: string;
  /** Human-readable token name */
  tokenName: string;
  /** Token symbol */
  tokenSymbol: string;
  /** Entry price in USD (null until captured) */
  entryPriceUsd: number | null;
  /** Total cost of entry in USD (null until captured) */
  entryCostUsd: number | null;
  /** Position size in SOL */
  sizeSol: number;
  /** Actually filled SOL amount (may differ from sizeSol on partial fill) */
  filledSol: number;
  /** Average fill price in USD (may differ from entryPriceUsd on partial fill) */
  avgFillPriceUsd: number | null;
  /** Highest price reached since position was opened */
  peakPriceUsd: number;
  /** Whether the trailing stop has been activated */
  trailingActive: boolean;
  /** TP/SL tasks indexed by group index (for partial tiers) */
  tasks: Map<number, PnLTaskSnapshot>;
  /** Current unrealised profit as a percentage */
  currentProfitPercent: number;
  /** Current unrealised profit in USD */
  currentProfitUsd: number;
  /** Remaining token balance as a string (precision-safe) */
  remainingBalance: string;
  /** Epoch timestamp (ms) when the position was opened */
  openedAt: number;
  /** Epoch timestamp (ms) of base TTL expiration */
  expiresAt: number;
  /** Epoch timestamp (ms) of the last state update */
  lastUpdateAt: number;
  /** Current lifecycle status of the position */
  status: PositionStatus;
  /** Why the position was closed (null while open / closing) */
  closeReason: CloseReason | null;
  /** Actual exit price in USD from the final sell execution (null if not captured) */
  exitPriceUsd: number | null;
  /** The parsed signal that originally triggered this position */
  signal: ParsedSignal;
}

/**
 * Events emitted during the position lifecycle
 */
export interface PositionEvent {
  /** Type of lifecycle event that occurred */
  type: "opened" | "updated" | "task_update" | "trailing_triggered" | "closed";
  /** The position state at the time of the event */
  position: PositionState;
  /** Reason for closure (only set when type is "closed") */
  closeReason?: CloseReason;
  /** Optional human-readable detail about the event */
  detail?: string;
}

/**
 * Default execution parameters for simulator swap orders.
 *
 * These values are used as fallbacks when no override is provided
 * for a specific swap order request.
 */
export const EXEC_DEFAULTS: {
  /** Target blockchain — always "solana" */
  chain: "solana";
  /** Wallet ID to execute the swap (empty = auto-select) */
  walletId: string;
  /** Priority fee for transaction (empty = auto-estimate) */
  priorityFee: number | "";
  /** Default slippage fraction (e.g., 0.1 = 10%) */
  slippage: number;
} = {
  chain: "solana" as const,         // Target blockchain for swap execution
  walletId: "",                     // Wallet identifier (empty = auto-select)
  priorityFee: "" as const,         // Priority fee (empty = auto-estimate by API)
  slippage: CONFIG.defaultSlippage, // Default slippage tolerance fraction from config
};
