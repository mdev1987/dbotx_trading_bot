// Load environment variables from .env file via dotenvx
import "@dotenvx/dotenvx/config";

/**
 * Represents a partial take-profit tier: sell pct% of position when price reaches at% above entry
 */
export interface PartialTpTier {
  /** Fraction of position to sell at this tier */
  pct: number;
  /** Price increase fraction (e.g., 0.1 = 10% above entry) at which to trigger this tier */
  at: number;
}

/**
 * Read a required environment variable, throwing if missing
 * @param key - Name of the environment variable
 * @returns The string value of the environment variable
 * @throws Error if the variable is not set
 */
function required(key: string): string {
  // Look up the env var
  const val = process.env[key];
  // Throw if not set
  if (!val) {
    throw new Error(`[config] Missing required environment variable: ${key}`);
  }
  // Return the value
  return val;
}

/**
 * Read a numeric environment variable with an optional fallback
 * @param key - Name of the environment variable
 * @param fallback - Optional default value if not set
 * @returns The parsed numeric value
 * @throws Error if the variable is missing (without fallback) or invalid
 */
function number(key: string, fallback?: number): number {
  // Get the raw string from environment
  const raw = process.env[key];
  // If undefined or empty, use fallback or throw
  if (raw === undefined || raw === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(
      `[config] Missing required numeric environment variable: ${key}`,
    );
  }
  // Parse to number
  const n = Number(raw);
  // Reject non-finite values (NaN, Infinity)
  if (!Number.isFinite(n)) {
    throw new Error(`[config] Invalid number for ${key}: "${raw}"`);
  }
  return n;
}

/**
 * Parse a string like "25%@50%,25%@100%" into PartialTpTier array
 * @param raw - Comma-separated tier string with pct%@at% format
 * @returns Array of parsed PartialTpTier objects
 * @throws Error if any tier segment has an invalid format or non-positive values
 */
function parsePartialTpTiers(raw: string | undefined): PartialTpTier[] {
  // Guard: return empty array when env var is not set or empty
  if (!raw) return [];

  // Split the raw string on commas to get individual tier segments
  return raw.split(",").flatMap((part) => {
    // Trim whitespace, then split "25%@50%" into ["25%", "50%"]
    const trimmed = part.trim();
    const [pctStr, atStr] = trimmed.split("@");

    // Guard: reject input that doesn't have exactly two parts
    if (!pctStr || !atStr) {
      throw new Error(
        `[config] invalid partial TP tier: "${part}" – expected format "pct%@at%", got pct="${pctStr}" at="${atStr}"`,
      );
    }

    // Strip trailing '%' character from each segment before parsing
    const pctClean = pctStr.replace(/%$/, "");
    const atClean = atStr.replace(/%$/, "");

    // Convert cleaned percentage strings to decimals (e.g., "25" -> 0.25)
    const pct = Number(pctClean) / 100;
    const at = Number(atClean) / 100;

    // Validate: must be positive finite numbers (rejects NaN, Infinity, 0, negatives)
    if (!Number.isFinite(pct) || !Number.isFinite(at) || pct <= 0 || at <= 0) {
      throw new Error(
        `[config] invalid partial TP tier: "${part}" – expected format "pct%@at%", got pct="${pctStr}" at="${atStr}"`,
      );
    }

    // Sum of all tier pcts should ideally be <= 1.0 (remainder handled by backstop)

    // flatMap merges this single-element array into the outer result
    return [{ pct, at }];
  });
}

/**
 * Consolidated configuration object derived from environment variables
 */
export const CONFIG = {
  /** DBotX API authentication */
  dbotxApiKey: required("DBOTX_API_KEY"),
  /** WebSocket endpoint for real-time market data */
  wsUrl: required("DBOTX_WS_URL"),
  /** REST API base URL for simulator operations */
  baseUrl: required("DBOTX_BASE_URL"),
  /** Service API base URL (defaults to production) */
  servapiBaseUrl: required("DBOTX_SERVAPI_BASE_URL"),

  /** Maximum number of concurrent positions (AVE mode only) */
  maxPositions: number("MAX_POSITIONS", 5),
  /** Base time-to-live for a position in seconds before auto-close */
  baseTtlSecs: number("BASE_TTL_SECS", 90),
  /** Minimum profit percentage threshold to renew TTL (0 = disabled) */
  minProfitForTtlExtensionPct:
    number("MIN_PROFIT_FOR_TTL_EXTENSION_PCT", 0) / 100,
  /** Hard cap on position TTL in seconds */
  maxTtlSecs: number("MAX_TTL_SECS", 600),
  /** Maximum number of queued signals when at max positions */
  signalQueueSize: number("SIGNAL_QUEUE_SIZE", 30),
  /** TTL (seconds) for signals in the queue before they expire */
  signalQueueTtlSecs: number("SIGNAL_QUEUE_TTL_SECS", 600),
  /** Base position size in SOL */
  positionSize: number("POSITION_SIZE_SOL", 0.1),
  /** Minimum position size in SOL */
  minPositionSol: number("MIN_POSITION_SOL", 0.03),
  /** Maximum position size in SOL */
  maxPositionSol: number("MAX_POSITION_SOL", 0.1),
  /** Maximum percentage of account balance to risk per position */
  maxRiskPct: number("MAX_RISK_PCT", 1),
  /** Stop-loss threshold as a fraction (e.g., 0.05 = 5% below entry) */
  stopLossPct: number("PAPER_STOP_LOSS_PERCENT") / 100,
  /** Price increase fraction needed to activate trailing stop */
  trailingActivationPct: number("PAPER_TRAILING_ACTIVATION_PERCENT") / 100,
  /** Distance fraction for trailing stop below peak price */
  trailingDistancePct: number("PAPER_TRAILING_STOP_PERCENT") / 100,
  /** Distance fraction for trailing take-profit below peak price (always active from entry) */
  trailingTpDistancePct: number("PAPER_TRAILING_TP_PERCENT") / 100,

  /** Enable partial take-profit tiers (scaling out) */
  partialTpEnabled:
    process.env.PARTIAL_TP_ENABLED?.toLowerCase() === "true",

  /** Partial take-profit tiers for scaling out */
  partialTpTiers: parsePartialTpTiers(process.env.PARTIAL_TP_TIERS),

  /** Backstop TP: close remaining position at this profit level */
  backstopTpPct: (() => {
    // Prefer the new env var name; fall back to the legacy key for backward compat
    const raw =
      process.env.PAPER_BACKSTOP_TP_PERCENT ??
      process.env.PAPER_TAKE_PROFIT_PERCENT;

    // Convert to number; Number("") and Number(undefined) both produce NaN
    const n = Number(raw);

    // If the parsed value is a finite number, convert from percentage to decimal;
    // otherwise default to 0 (no automatic backstop TP).
    return Number.isFinite(n) ? n / 100 : 0;
  })(),

  /** Maximum allowed slippage on exit as a fraction */
  maxSlippageExitPct: number("PAPER_MAX_SLIPPAGE_EXIT_PERCENT") / 100,

  /** Telegram bot credentials for status reporting */
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  /** Telegram chat ID for status messages */
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  /** Interval in minutes between periodic performance reports */
  reportIntervalMinutes: number("TELEGRAM_REPORT_INTERVAL_MINUTES", 5),

  /** Telegram MTProto client credentials for listening to signals */
  telegramApiId: process.env.TELEGRAM_API_ID,
  /** Telegram API hash for MTProto authentication */
  telegramApiHash: process.env.TELEGRAM_API_HASH,
  /** Telegram channel username for signal source */
  telegramChannelUserName: required("TELEGRAM_CHANNEL_USERNAME")
    .trim()
    .toLocaleLowerCase(),

  /** Telegram channel ID (numeric, alternative to username) */
  telegramChannelId: process.env.TELEGRAM_CHANNEL_ID,

  /** Path to the SQLite database file for persisting trade history */
  sqlitePath: process.env.SQLITE_PATH ?? "./data/paper_trading.sqlite",

  /** If true, clear all analytics data on application startup */
  clearAnalyticsOnStart:
    process.env.CLEAR_ANALYTICS_ON_START?.toLowerCase() === "true",

  /** Daily loss limit in USD; stops new trades if exceeded (0 = no limit) */
  dailyLossLimitUsd: number("DAILY_LOSS_LIMIT_USD", 0),

  // ──────────────────────────────────────────
  // Polling & timing intervals
  // ──────────────────────────────────────────

  /** Interval (ms) at which TP/SL task states are polled for open positions */
  pnlTaskPollMs: number("PNL_TASK_POLL_MS", 5_000),
  /** Interval (ms) at which trade-pair balances / live PnL are polled */
  tradePairPollMs: number("TRADE_PAIR_POLL_MS", 30_000),
  /** Delay (ms) between retry attempts when capturing entry price after a buy */
  entryPricePollDelayMs: number("ENTRY_PRICE_POLL_DELAY_MS", 1_000),
  /** Maximum number of retry attempts when capturing entry price */
  maxEntryPriceAttempts: number("MAX_ENTRY_PRICE_ATTEMPTS", 10),
  /** TTL (ms) for the pending-buy dedup guard (prevents double-buying) */
  pendingBuyTtlMs: number("PENDING_BUY_TTL_MS", 60_000),
  /** Interval (ms) at which open positions are checked for TTL expiry */
  expiryCheckMs: number("POSITION_EXPIRY_CHECK_MS", 15_000),

  /** Interval (ms) at which the simulator account balance is auto-refreshed */
  accountPollIntervalMs: number("ACCOUNT_POLL_INTERVAL_MS", 60_000),

  // ──────────────────────────────────────────
  // WebSocket
  // ──────────────────────────────────────────

  /** Heartbeat/ping interval (ms) for the WebSocket connection */
  wsHeartbeatIntervalMs: number("WS_HEARTBEAT_INTERVAL_MS", 30_000),
  /** Throttle (ms) for repeated WebSocket disconnect log messages */
  wsDisconnectLogThrottleMs: number("WS_DISCONNECT_LOG_THROTTLE_MS", 30_000),
  /** Delay (ms) before reconnecting after a WebSocket disconnect */
  wsReconnectDelayMs: number("WS_RECONNECT_DELAY_MS", 5_000),

  // ──────────────────────────────────────────
  // Signal deduplication
  // ──────────────────────────────────────────

  /** TTL (seconds) for the signal dedup cache — signals are evicted after this */
  signalCacheTtlSeconds: number("SIGNAL_CACHE_TTL_SECONDS", 3_600),
  /** Interval (ms) for the signal cache cleanup tick */
  signalCleanupIntervalMs: number("SIGNAL_CLEANUP_INTERVAL_MS", 5_000),

  // ──────────────────────────────────────────
  // HTTP client
  // ──────────────────────────────────────────

  /** Maximum HTTP request retry count */
  httpMaxRetries: number("HTTP_MAX_RETRIES", 4),
  /** Base delay (ms) for exponential backoff between HTTP retries */
  httpBaseDelayMs: number("HTTP_BASE_DELAY_MS", 1_000),
  /** HTTP request timeout (ms) */
  httpTimeoutMs: number("HTTP_TIMEOUT_MS", 30_000),

  // ──────────────────────────────────────────
  // Telegram connection
  // ──────────────────────────────────────────

  /** Maximum Telegram MTProto connection retry attempts */
  tgConnectionRetries: number("TG_CONNECTION_RETRIES", 5),
  /** Delay (ms) between Telegram connection retries */
  tgRetryDelayMs: number("TG_RETRY_DELAY_MS", 5_000),
  /** Timeout (ms) for Telegram CLI authentication input */
  tgAuthTimeoutMs: number("TG_AUTH_TIMEOUT_MS", 300_000),

  // ──────────────────────────────────────────
  // Simulator execution defaults
  // ──────────────────────────────────────────

  /** Default slippage fraction for simulator swap orders (e.g. 0.1 = 10 %) */
  defaultSlippage: number("DEFAULT_SLIPPAGE", 0.1),
  /** Default gas fee delta for simulator orders */
  defaultGasFeeDelta: number("DEFAULT_GAS_FEE_DELTA", 5),
  /** Default max fee per gas for simulator orders */
  defaultMaxFeePerGas: number("DEFAULT_MAX_FEE_PER_GAS", 100),

  // ──────────────────────────────────────────
  // Live trading mode
  // ──────────────────────────────────────────

  /** When true, the application boots into live trading mode instead of simulator. */
  liveMode: process.env.LIVE_MODE?.toLowerCase() === "true",

  /** Logging verbosity level */
  logLevel: process.env.LOG_LEVEL ?? "info",
};
