import "@dotenvx/dotenvx/config";

export interface PartialTpTier {
  pct: number;
  at: number;
}

function required(key: string, altKey?: string): string {
  const val = process.env[key] ?? (altKey ? process.env[altKey] : undefined);
  if (!val) {
    const hint = altKey ? ` (also tried ${altKey})` : "";
    throw new Error(`[config] Missing required environment variable: ${key}${hint}`);
  }
  return val;
}

function number(key: string, fallback?: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(
      `[config] Missing required numeric environment variable: ${key}`,
    );
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`[config] Invalid number for ${key}: "${raw}"`);
  }
  return n;
}

function parsePartialTpTiers(raw: string | undefined): PartialTpTier[] {
  if (!raw) return [];
  return raw.split(",").flatMap((part) => {
    const trimmed = part.trim();
    const [pctStr, atStr] = trimmed.split("@");
    if (!pctStr || !atStr) {
      throw new Error(
        `[config] invalid partial TP tier: "${part}" — expected format "pct%@at%"`,
      );
    }
    const pctClean = pctStr.replace(/%$/, "");
    const atClean = atStr.replace(/%$/, "");
    const pct = Number(pctClean) / 100;
    const at = Number(atClean) / 100;
    if (!Number.isFinite(pct) || !Number.isFinite(at) || pct <= 0 || at <= 0) {
      throw new Error(
        `[config] invalid partial TP tier: "${part}" - values must be positive`,
      );
    }
    return [{ pct, at }];
  });
}

export const CONFIG = {
  // ── DBotX API — Connection ──────────────────────────────────────────────
  dbotxApiKey: required("DBOTX_API_KEY", "DBOTX_API_KEY_SEALED"),
  wsUrl: required("DBOTX_WS_URL"),
  baseUrl: required("DBOTX_BASE_URL"),
  servapiBaseUrl: required("DBOTX_SERVAPI_BASE_URL"),
  dataBaseUrl: process.env.DBOTX_DATA_BASE_URL ?? "https://api-data-v1.dbotx.com",

  // ── Trading — Position Sizing & Limits ──────────────────────────────────
  maxPositions: number("MAX_POSITIONS", 5),
  baseTtlSecs: number("BASE_TTL_SECS", 90),
  minProfitForTtlExtensionPct:
    number("MIN_PROFIT_FOR_TTL_EXTENSION_PCT", 0) / 100,
  maxTtlSecs: number("MAX_TTL_SECS", 600),
  signalQueueSize: number("SIGNAL_QUEUE_SIZE", 30),
  signalQueueTtlSecs: number("SIGNAL_QUEUE_TTL_SECS", 600),
  positionSize: number("POSITION_SIZE_SOL", 0.1),
  minPositionSol: number("MIN_POSITION_SOL", 0.03),
  maxPositionSol: number("MAX_POSITION_SOL", 0.1),
  maxRiskPct: number("MAX_RISK_PCT", 1),

  // ── Trading — Take-Profit / Stop-Loss ───────────────────────────────────
  stopLossPct: (() => {
    const raw = process.env.STOP_LOSS_PERCENT ?? process.env.PAPER_STOP_LOSS_PERCENT;
    const n = Number(raw);
    return Number.isFinite(n) ? n / 100 : 0;
  })(),

  trailingActivationPct: (() => {
    const raw = process.env.TRAILING_ACTIVATION_PERCENT ?? process.env.PAPER_TRAILING_ACTIVATION_PERCENT;
    const n = Number(raw);
    return Number.isFinite(n) ? n / 100 : 0;
  })(),

  trailingDistancePct: (() => {
    const raw = process.env.TRAILING_STOP_PERCENT ?? process.env.PAPER_TRAILING_STOP_PERCENT;
    const n = Number(raw);
    return Number.isFinite(n) ? n / 100 : 0;
  })(),

  trailingTpDistancePct: (() => {
    const raw = process.env.TRAILING_TP_PERCENT ?? process.env.PAPER_TRAILING_TP_PERCENT;
    const n = Number(raw);
    return Number.isFinite(n) ? n / 100 : 0;
  })(),

  partialTpEnabled:
    process.env.PARTIAL_TP_ENABLED?.toLowerCase() === "true",

  partialTpTiers: parsePartialTpTiers(process.env.PARTIAL_TP_TIERS),

  backstopTpPct: (() => {
    const raw =
      process.env.BACKSTOP_TP_PERCENT ??
      process.env.PAPER_BACKSTOP_TP_PERCENT ??
      process.env.PAPER_TAKE_PROFIT_PERCENT;
    const n = Number(raw);
    return Number.isFinite(n) ? n / 100 : 0;
  })(),

  maxSlippageExitPct: (() => {
    const raw = process.env.MAX_SLIPPAGE_EXIT_PERCENT ?? process.env.PAPER_MAX_SLIPPAGE_EXIT_PERCENT;
    const n = Number(raw);
    return Number.isFinite(n) ? n / 100 : 0;
  })(),

  // ── Risk Controls ──────────────────────────────────────────────────────
  dailyLossLimitUsd: number("DAILY_LOSS_LIMIT_USD", 0),
  maxBuysPerMinute: number("MAX_BUYS_PER_MINUTE", 3),
  maxBuysPerHour: number("MAX_BUYS_PER_HOUR", 20),
  maxTotalSolDeployed: number("MAX_TOTAL_SOL_DEPLOYED", 0),
  maxPortfolioExposurePct: number("MAX_PORTFOLIO_EXPOSURE_PCT", 100) / 100,
  maxConsecutiveApiFailures: number("MAX_CONSECUTIVE_API_FAILURES", 5),
  duplicateLockWindowMs: number("DUPLICATE_LOCK_WINDOW_MS", 5_000),
  stopTradingPath: process.env.STOP_TRADING_PATH ?? "./STOP_TRADING_LIVE",
  maxPriceDeviationPct: number("MAX_PRICE_DEVIATION_PCT", 0) / 100,

  // ── Data & Analytics ───────────────────────────────────────────────────
  sqlitePath: process.env.SQLITE_PATH ?? "./data/paper_trading.sqlite",
  clearAnalyticsOnStart:
    process.env.CLEAR_ANALYTICS_ON_START?.toLowerCase() === "true",

  // ── Telegram ───────────────────────────────────────────────────────────
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  reportIntervalMinutes: number("TELEGRAM_REPORT_INTERVAL_MINUTES", 5),
  telegramApiId: process.env.TELEGRAM_API_ID,
  telegramApiHash: process.env.TELEGRAM_API_HASH,
  telegramChannelUserName: required("TELEGRAM_CHANNEL_USERNAME")
    .trim()
    .toLocaleLowerCase(),
  telegramChannelId: process.env.TELEGRAM_CHANNEL_ID,

  // ── Polling & Timing ───────────────────────────────────────────────────
  pnlTaskPollMs: number("PNL_TASK_POLL_MS", 5_000),
  tradePairPollMs: number("TRADE_PAIR_POLL_MS", 30_000),
  entryPricePollDelayMs: number("ENTRY_PRICE_POLL_DELAY_MS", 1_000),
  maxEntryPriceAttempts: number("MAX_ENTRY_PRICE_ATTEMPTS", 10),
  pendingBuyTtlMs: number("PENDING_BUY_TTL_MS", 60_000),
  expiryCheckMs: number("POSITION_EXPIRY_CHECK_MS", 15_000),
  accountPollIntervalMs: number("ACCOUNT_POLL_INTERVAL_MS", 60_000),
  reconciliationIntervalMs: number("RECONCILIATION_INTERVAL_MS", 60_000),

  // ── WebSocket ──────────────────────────────────────────────────────────
  wsHeartbeatIntervalMs: number("WS_HEARTBEAT_INTERVAL_MS", 30_000),
  wsDisconnectLogThrottleMs: number("WS_DISCONNECT_LOG_THROTTLE_MS", 30_000),
  wsReconnectDelayMs: number("WS_RECONNECT_DELAY_MS", 5_000),

  // ── Signal Deduplication ───────────────────────────────────────────────
  signalCacheTtlSeconds: number("SIGNAL_CACHE_TTL_SECONDS", 3_600),
  signalCleanupIntervalMs: number("SIGNAL_CLEANUP_INTERVAL_MS", 5_000),

  // ── HTTP Client ────────────────────────────────────────────────────────
  httpMaxRetries: number("HTTP_MAX_RETRIES", 4),
  httpBaseDelayMs: number("HTTP_BASE_DELAY_MS", 1_000),
  httpTimeoutMs: number("HTTP_TIMEOUT_MS", 30_000),

  // ── Telegram Connection — MTProto ──────────────────────────────────────
  tgConnectionRetries: number("TG_CONNECTION_RETRIES", 5),
  tgRetryDelayMs: number("TG_RETRY_DELAY_MS", 5_000),
  tgAuthTimeoutMs: number("TG_AUTH_TIMEOUT_MS", 300_000),

  // ── Simulator Execution Defaults ───────────────────────────────────────
  defaultSlippage: number("DEFAULT_SLIPPAGE", 0.1),
  defaultGasFeeDelta: number("DEFAULT_GAS_FEE_DELTA", 5),
  defaultMaxFeePerGas: number("DEFAULT_MAX_FEE_PER_GAS", 100),

  // ── Mode ───────────────────────────────────────────────────────────────
  liveMode: process.env.LIVE_MODE?.toLowerCase() === "true",

  // ── Observability ──────────────────────────────────────────────────────
  logLevel: process.env.LOG_LEVEL ?? "info",
};
