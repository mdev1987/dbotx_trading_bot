/**
 * Live trading configuration derived from environment variables.
 *
 * Every live-specific config key is read here so that the rest of the live
 * module imports configuration from a single, testable location.
 */
import "@dotenvx/dotenvx/config";

/**
 * Read a required environment variable, throwing if missing.
 * @param key - Name of the environment variable.
 * @returns The string value.
 */
function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`[live/config] Missing required env: ${key}`);
  return val;
}

/**
 * Read a numeric environment variable with optional fallback.
 * @param key - Name of the environment variable.
 * @param fallback - Default value if the variable is not set.
 * @returns The parsed number.
 */
function number(key: string, fallback?: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`[live/config] Missing required numeric env: ${key}`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`[live/config] Invalid number for ${key}: "${raw}"`);
  return n;
}

/**
 * Parse a comma-separated list of partial TP tiers like "25@30,25@60,25@100".
 * Each segment is "pct@at" where both values are percentages.
 */
function parsePartialTpTiers(raw: string | undefined): { pct: number; at: number }[] {
  if (!raw) return [];
  return raw.split(",").flatMap((part) => {
    const trimmed = part.trim();
    const [pctStr, atStr] = trimmed.split("@");
    if (!pctStr || !atStr) throw new Error(`[live/config] Invalid TP tier: "${part}"`);
    const pct = Number(pctStr.replace(/%$/, "")) / 100;
    const at = Number(atStr.replace(/%$/, "")) / 100;
    if (!Number.isFinite(pct) || !Number.isFinite(at) || pct <= 0 || at <= 0) {
      throw new Error(`[live/config] Invalid TP tier values: "${part}"`);
    }
    return [{ pct, at }];
  });
}

export const LIVE_CONFIG = {
  // ── Mode ──────────────────────────────────────────────────────────────────
  /** Master switch: when true the application boots into live trading mode. */
  liveMode: process.env.LIVE_MODE?.toLowerCase() === "true",

  // ── API keys ──────────────────────────────────────────────────────────────
  /** API key used for authentication against both bot and data endpoints. */
  dbotxApiKey: required("DBOTX_API_KEY"),

  // ── Endpoints ─────────────────────────────────────────────────────────────
  /** Trading bot REST API base URL. */
  baseUrl: process.env.DEBOT_BASE_URL ?? "https://api-bot-v1.dbotx.com",

  /** Data REST API base URL (used for wallet balance queries). */
  dataBaseUrl: process.env.DEBOT_DATA_BASE_URL ?? "https://api-data-v1.dbotx.com",

  /** Trading WebSocket URL for creating orders and subscribing to results. */
  tradeWsUrl: process.env.LIVE_TRADE_WS_URL ?? "wss://api-bot-v1.dbotx.com/trade/ws/",

  // ── Wallet ────────────────────────────────────────────────────────────────
  /** The wallet ID (obtained from DBotX "Wallet Info" API / dashboard). */
  walletId: required("LIVE_WALLET_ID"),

  /** The wallet public address on-chain. */
  walletAddress: required("LIVE_WALLET_ADDRESS"),

  // ── Position sizing ───────────────────────────────────────────────────────
  /** Default position size in SOL. */
  positionSize: number("POSITION_SIZE_SOL", 0.1),

  /** Minimum position size in SOL (floor enforced before order placement). */
  minPositionSol: number("MIN_POSITION_SOL", 0.03),

  /** Maximum position size in SOL (cap enforced before order placement). */
  maxPositionSol: number("MAX_POSITION_SOL", 0.1),

  /** Maximum percentage of the wallet SOL balance that may be risked on a single position. */
  maxRiskPct: number("MAX_RISK_PCT", 10) / 100,

  /** Estimated SOL/USD price used for converting USD-denominated caps to SOL amounts. */
  solPriceUsd: number("SOL_PRICE_USD", 150),

  // ── Limits ────────────────────────────────────────────────────────────────
  /** Maximum number of concurrently open positions. */
  maxPositions: number("MAX_POSITIONS", 20),

  /** Maximum number of queued signals when at max positions. */
  signalQueueSize: number("SIGNAL_QUEUE_SIZE", 30),

  /** TTL (seconds) for signals in the queue before they expire. */
  signalQueueTtlSecs: number("SIGNAL_QUEUE_TTL_SECS", 600),

  // ── Position TTL ──────────────────────────────────────────────────────────
  /** Base time-to-live in seconds for a position. */
  baseTtlSecs: number("BASE_TTL_SECS", 300),

  /** Minimum profit % to grant a TTL extension (0 = disabled). */
  minProfitForTtlExtensionPct: number("MIN_PROFIT_FOR_TTL_EXTENSION_PCT", 0) / 100,

  /** Hard cap on total position TTL in seconds. */
  maxTtlSecs: number("MAX_TTL_SECS", 3600),

  // ── Take-profit / Stop-loss (server-side, sent in swap order) ────────────
  /** Partial TP tiers for scaling out (server-managed). */
  partialTpTiers: parsePartialTpTiers(process.env.PARTIAL_TP_TIERS),

  /** Backstop TP: close remaining at this profit level. */
  backstopTpPct: (() => {
    const raw = process.env.PAPER_BACKSTOP_TP_PERCENT ?? process.env.PAPER_TAKE_PROFIT_PERCENT;
    const n = Number(raw);
    return Number.isFinite(n) ? n / 100 : 0;
  })(),

  /** Fixed stop-loss as a fraction (e.g., 0.15 = 15 %). */
  stopLossPct: number("PAPER_STOP_LOSS_PERCENT", 15) / 100,

  // ── Trailing stop / TP (client-side) ──────────────────────────────────────
  /** Gain % needed to activate the trailing stop. */
  trailingActivationPct: number("PAPER_TRAILING_ACTIVATION_PERCENT", 15) / 100,

  /** Drop % from peak that triggers a trailing stop sell. */
  trailingStopPct: number("PAPER_TRAILING_STOP_PERCENT", 8) / 100,

  /** Drop % from peak that triggers a trailing TP sell (always active). */
  trailingTpPct: number("PAPER_TRAILING_TP_PERCENT", 12) / 100,

  /** Max slippage on exit. */
  maxSlippageExitPct: number("PAPER_MAX_SLIPPAGE_EXIT_PERCENT", 80) / 100,

  // ── Live execution defaults ───────────────────────────────────────────────
  /**
   * Jito anti-MEV enabled by default.
   * When enabled the system auto-allocates the Jito tip unless customFeeAndTip
   * is set.  Setting customFeeAndTip=false (default) lets the server manage
   * the allocation — in anti-MEV mode only jitoTip is used, auto-allocated.
   */
  jitoEnabled: (process.env.LIVE_JITO_ENABLED ?? "true").toLowerCase() === "true",

  /** Bribery tip for anti-MEV (SOL). Only used when jitoEnabled is true AND customFeeAndTip is true. */
  jitoTip: number("LIVE_JITO_TIP", 0.0001),

  /**
   * When false (default): turbo mode = only priorityFee valid, anti-MEV mode = only jitoTip valid,
   * and the system auto-allocates them.  When true: both priorityFee and jitoTip are used as-provided.
   */
  customFeeAndTip: (process.env.LIVE_CUSTOM_FEE_AND_TIP ?? "false").toLowerCase() === "true",

  /** Priority fee in SOL (empty string = auto). */
  priorityFee: process.env.LIVE_PRIORITY_FEE ?? "",

  /** Max slippage for swap orders (0.00-1.00). */
  maxSlippage: number("LIVE_MAX_SLIPPAGE", 0.1),

  /** Number of concurrent nodes (1-3). */
  concurrentNodes: number("LIVE_CONCURRENT_NODES", 2),

  /** Number of retries after failure (0-10). */
  retries: number("LIVE_RETRIES", 1),

  /** Migrate (opening) sell ratio (0 = disabled). Enables auto-sell on Pump→Raydium migration. */
  migrateSellPercent: number("LIVE_MIGRATE_SELL_PERCENT", 1),

  /** Dev sell trigger ratio (0 = disabled). Sells when dev sells more than this ratio. */
  minDevSellPercent: number("LIVE_MIN_DEV_SELL_PERCENT", 0.5),

  /** Amount ratio to sell when Dev sell is triggered (0 = disabled). */
  devSellPercent: number("LIVE_DEV_SELL_PERCENT", 0),

  // ── PnL order (TP/SL) lifecycle ───────────────────────────────────────────
  /** Expiry for TP/SL tasks in ms (max 432_000_000 = 5 days). */
  pnlOrderExpireDeltaMs: number("LIVE_PNL_ORDER_EXPIRE_DELTA_MS", 43_200_000),

  /** Execute sell when TP/SL expires (true = market sell at expiry). */
  pnlOrderExpireExecute: (process.env.LIVE_PNL_ORDER_EXPIRE_EXECUTE ?? "true").toLowerCase() === "true",

  /** Use 1-second mid-price for anti-spike TP/SL triggering. */
  pnlOrderUseMidPrice: (process.env.LIVE_PNL_ORDER_USE_MID_PRICE ?? "true").toLowerCase() === "true",

  // ── Polling & timing ──────────────────────────────────────────────────────
  /** Interval (ms) for polling pending swap order status. */
  swapOrderPollMs: number("LIVE_SWAP_ORDER_POLL_MS", 2_000),

  /** Max attempts to poll a pending swap order before giving up. */
  maxSwapOrderPollAttempts: number("LIVE_MAX_SWAP_ORDER_POLL_ATTEMPTS", 30),

  /** Interval (ms) for wallet balance polling. */
  accountPollIntervalMs: number("ACCOUNT_POLL_INTERVAL_MS", 60_000),

  /** Interval (ms) for checking TTL expiry. */
  expiryCheckMs: number("POSITION_EXPIRY_CHECK_MS", 15_000),

  /** Pending-buy dedup guard TTL (ms). */
  pendingBuyTtlMs: number("PENDING_BUY_TTL_MS", 60_000),

  // ── WebSocket ─────────────────────────────────────────────────────────────
  /** Heartbeat interval (ms) for the trade results WS. */
  wsHeartbeatIntervalMs: number("WS_HEARTBEAT_INTERVAL_MS", 30_000),

  /** Reconnect delay (ms) after WS disconnect. */
  wsReconnectDelayMs: number("WS_RECONNECT_DELAY_MS", 5_000),

  // ── HTTP ──────────────────────────────────────────────────────────────────
  httpMaxRetries: number("HTTP_MAX_RETRIES", 4),
  httpBaseDelayMs: number("HTTP_BASE_DELAY_MS", 1_000),
  httpTimeoutMs: number("HTTP_TIMEOUT_MS", 30_000),

  // ── Recovery ──────────────────────────────────────────────────────────────
  /** When true, recover positions from SQLite on startup. */
  recoveryOnStart: (process.env.LIVE_RECOVERY_ON_START ?? "true").toLowerCase() === "true",

  /** Path to the live-trading SQLite database file. */
  liveDbPath: process.env.LIVE_DB_PATH ?? "./data/live_trading.sqlite",

  // ── Duplicate protection ──────────────────────────────────────────────────
  /** Window (ms) during which a pair+timestamp lock prevents duplicate buys. */
  duplicateLockWindowMs: number("DUPLICATE_LOCK_WINDOW_MS", 5_000),

  // ── Emergency stop ────────────────────────────────────────────────────────
  /** Path to the STOP_TRADING sentinel file (create to halt new buys). */
  stopTradingPath: process.env.STOP_TRADING_PATH ?? "./STOP_TRADING_LIVE",

  /** Maximum number of consecutive API failures before auto-pause. */
  maxConsecutiveApiFailures: number("MAX_CONSECUTIVE_API_FAILURES", 5),

  // ── Portfolio limits ──────────────────────────────────────────────────────
  /** Maximum percentage of wallet balance that can be deployed across all positions. */
  maxPortfolioExposurePct: number("MAX_PORTFOLIO_EXPOSURE_PCT", 100) / 100,

  // ── Daily loss ────────────────────────────────────────────────────────────
  /** Daily realised loss limit in USD (0 = disabled). */
  dailyLossLimitUsd: number("DAILY_LOSS_LIMIT_USD", 20),

  // ── Telegram ──────────────────────────────────────────────────────────────
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
};
