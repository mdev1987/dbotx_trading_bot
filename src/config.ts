import "@dotenvx/dotenvx/config";

export interface PartialTpTier {
  pct: number;
  at: number;
}

function required(key: string, altKey?: string): string {
  const val = process.env[key] ?? (altKey ? process.env[altKey] : undefined);
  if (!val) {
    const hint = altKey ? ` (also tried ${altKey})` : "";
    throw new Error(
      `[config] Missing required environment variable: ${key}${hint}`,
    );
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
  if (!Number.isFinite(n))
    throw new Error(`[config] Invalid number for ${key}: "${raw}"`);
  return n;
}

export function parsePartialTpTiers(raw: string | undefined): PartialTpTier[] {
  if (!raw) return [];
  return raw.split(",").flatMap((part) => {
    const trimmed = part.trim();
    const [pctStr, atStr] = trimmed.split("@");
    if (!pctStr || !atStr)
      throw new Error(`[config] invalid partial TP tier: "${part}"`);
    const pctClean = pctStr.replace(/%$/, "");
    const atClean = atStr.replace(/%$/, "");
    const pct = Number(pctClean) / 100;
    const at = Number(atClean) / 100;
    if (!Number.isFinite(pct) || !Number.isFinite(at) || pct <= 0 || at <= 0) {
      throw new Error(`[config] invalid partial TP tier: "${part}"`);
    }
    return [{ pct, at }];
  });
}

export const CONFIG = {
  // Engine selection
  tradingEngine: (process.env.TRADING_ENGINE ?? "pumpapi").toLowerCase() as
    | "pumpapi"
    | "dbotx",

  // PumpAPI
  pumpapiPrivateKey: process.env.PUMPAPI_PRIVATE_KEY ?? "",
  pumpapiBaseUrl: process.env.PUMPAPI_BASE_URL ?? "https://api.pumpapi.io",
  pumpapiPaperWalletBalanceSol: Number(
    process.env.PUMPAPI_PAPER_WALLET_BALANCE_SOL ?? 2,
  ),

  // DBotX API
  dbotxApiKey: required("DBOTX_API_KEY", "DBOTX_API_KEY_SEALED"),
  wsUrl: required("DBOTX_WS_URL"),
  baseUrl: required("DBOTX_BASE_URL"),
  servapiBaseUrl: required("DBOTX_SERVAPI_BASE_URL"),
  dataBaseUrl:
    process.env.DBOTX_DATA_BASE_URL ?? "https://api-data-v1.dbotx.com",
  tradeWsUrl:
    process.env.LIVE_TRADE_WS_URL ?? "wss://api-bot-v1.dbotx.com/trade/ws/",

  // Wallet (LIVE)
  walletId: process.env.LIVE_WALLET_ID ?? "",
  walletAddress: process.env.LIVE_WALLET_ADDRESS ?? "",

  // Position sizing & limits
  positionSize: number("POSITION_SIZE_SOL", 0.1),
  maxOpenPositions: number("MAX_OPEN_POSITIONS", 5),
  signalQueueMaxSize: number("SIGNAL_QUEUE_MAX_SIZE", 30),
  signalQueueTtlMs: number("SIGNAL_QUEUE_TTL_MS", 600_000),
  baseTtlSecs: number("BASE_TTL_SECS", 90),
  maxTtlSecs: number("MAX_TTL_SECS", 600),
  profitPercentChange: number("PROFIT_PERCENT_CHANGE", 8) / 100,

  // TP/SL
  stopLossEnabled: process.env.STOP_LOSS_ENABLED?.toLowerCase() === "true",
  stopLossPct: (() => {
    const raw = process.env.STOP_LOSS_PERCENT;
    const n = Number(raw);
    return Number.isFinite(n) ? n / 100 : 0;
  })(),
  trailingActivationPct: (() => {
    const raw = process.env.TRAILING_ACTIVATION_PERCENT;
    const n = Number(raw);
    return Number.isFinite(n) ? n / 100 : 0;
  })(),
  trailingDistancePct: (() => {
    const raw = process.env.TRAILING_STOP_PERCENT;
    const n = Number(raw);
    return Number.isFinite(n) ? n / 100 : 0;
  })(),
  partialTpEnabled: process.env.PARTIAL_TP_ENABLED?.toLowerCase() === "true",
  partialTpTiers: parsePartialTpTiers(process.env.PARTIAL_TP_TIERS),
  backstopTpPct: (() => {
    const raw = process.env.BACKSTOP_TP_PERCENT;
    const n = Number(raw);
    return Number.isFinite(n) ? n / 100 : 0;
  })(),
  stopLossTiers: parsePartialTpTiers(process.env.STOP_LOSS_TIERS),

  // Live execution
  jitoEnabled:
    (process.env.LIVE_JITO_ENABLED ?? "true").toLowerCase() === "true",
  jitoTip: number("LIVE_JITO_TIP", 0.0001),
  customFeeAndTip:
    (process.env.LIVE_CUSTOM_FEE_AND_TIP ?? "true").toLowerCase() === "true",
  priorityFee: process.env.LIVE_PRIORITY_FEE ?? "0.00002",
  maxSlippage: number("LIVE_MAX_SLIPPAGE", 0.15),
  concurrentNodes: number("LIVE_CONCURRENT_NODES", 2),
  retries: number("LIVE_RETRIES", 1),
  migrateSellPercent: number("LIVE_MIGRATE_SELL_PERCENT", 1),
  minDevSellPercent: number("LIVE_MIN_DEV_SELL_PERCENT", 0.5),
  devSellPercent: number("LIVE_DEV_SELL_PERCENT", 0),

  // PnL order lifecycle
  pnlOrderExpireDeltaMs: number("LIVE_PNL_ORDER_EXPIRE_DELTA_MS", 600_000),
  pnlOrderExpireExecute:
    (process.env.LIVE_PNL_ORDER_EXPIRE_EXECUTE ?? "true").toLowerCase() ===
    "true",
  pnlOrderExpireExecuteSellAll:
    (
      process.env.LIVE_PNL_ORDER_EXPIRE_EXECUTE_SELL_ALL ?? "false"
    ).toLowerCase() === "true",
  pnlOrderUseMidPrice:
    (process.env.LIVE_PNL_ORDER_USE_MID_PRICE ?? "true").toLowerCase() ===
    "true",

  // Exit PnL custom config
  pnlCustomConfigEnabled:
    (process.env.LIVE_PNL_CUSTOM_CONFIG_ENABLED ?? "true").toLowerCase() ===
    "true",
  exitCustomFeeAndTip:
    (process.env.LIVE_EXIT_CUSTOM_FEE_AND_TIP ?? "true").toLowerCase() ===
    "true",
  exitPriorityFee: process.env.LIVE_EXIT_PRIORITY_FEE ?? "0.00005",
  exitJitoEnabled:
    (process.env.LIVE_EXIT_JITO_ENABLED ?? "true").toLowerCase() === "true",
  exitJitoTip: number("LIVE_EXIT_JITO_TIP", 0.0001),
  exitMaxSlippage: number("LIVE_EXIT_MAX_SLIPPAGE", 0.3),
  balanceTtlMs: number("BALANCE_TTL_MS", 60_000),
  exitConcurrentNodes: number("LIVE_EXIT_CONCURRENT_NODES", 2),
  exitRetries: number("LIVE_EXIT_RETRIES", 2),

  // Telegram
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  telegramApiId: process.env.TELEGRAM_API_ID,
  telegramApiHash: process.env.TELEGRAM_API_HASH,
  telegramChannelUserName: required("TELEGRAM_CHANNEL_USERNAME")
    .trim()
    .toLocaleLowerCase(),
  telegramChannelId: process.env.TELEGRAM_CHANNEL_ID,
  telegramSessionName: process.env.TELEGRAM_SESSION_NAME ?? "telegram_session",

  // Polling & timing
  pnlTaskPollMs: number("PNL_TASK_POLL_MS", 5_000),
  maxLiveBuyPollAttempts: number("LIVE_MAX_SWAP_ORDER_POLL_ATTEMPTS", 30),

  // WebSocket
  wsHeartbeatIntervalMs: number("WS_HEARTBEAT_INTERVAL_MS", 30_000),
  wsReconnectDelayMs: number("WS_RECONNECT_DELAY_MS", 5_000),

  // Price Data Streams
  pumpapiWsUrl: process.env.PUMPAPI_WS_URL ?? "wss://stream.pumpapi.io/",
  dexscreenerApiUrl:
    process.env.DEXSCREENER_API_URL ?? "https://api.dexscreener.com/tokens/v1",
  dexscreenerPollIntervalMs: number("DEXSCREENER_POLL_INTERVAL_MS", 200),
  wsDataMaxReconnectDelayMs: number("WS_DATA_MAX_RECONNECT_DELAY_MS", 30_000),
  wsDataInitialReconnectDelayMs: number(
    "WS_DATA_INITIAL_RECONNECT_DELAY_MS",
    1_000,
  ),
  // Position engine
  positionScanIntervalMs: number("POSITION_SCAN_INTERVAL_MS", 1_000),

  // Trade WS
  tradeWsHeartbeatIntervalMs: number("TRADE_WS_HEARTBEAT_INTERVAL_MS", 30_000),

  // Live monitor
  liveReconcileIntervalMs: number("LIVE_RECONCILE_INTERVAL_MS", 300_000),

  // Recovery
  recoveryFetchPageSize: number("RECOVERY_FETCH_PAGE_SIZE", 20),

  // Handler / reporting
  maxRealisticPnlRatio: number("MAX_REALISTIC_PNL_RATIO", 10),
  bogusPnlTimeThresholdMs: number("BOGUS_PNL_TIME_THRESHOLD_MS", 60_000),
  tradeReportBatchSize: number("TRADE_REPORT_BATCH_SIZE", 100),

  // HTTP
  httpMaxRetries: number("HTTP_MAX_RETRIES", 4),
  httpBaseDelayMs: number("HTTP_BASE_DELAY_MS", 1_000),
  httpTimeoutMs: number("HTTP_TIMEOUT_MS", 30_000),

  // Telegram connection
  tgConnectionRetries: number("TG_CONNECTION_RETRIES", 5),
  tgRetryDelayMs: number("TG_RETRY_DELAY_MS", 5_000),
  tgAuthTimeoutMs: number("TG_AUTH_TIMEOUT_MS", 300_000),

  // Simulator defaults
  defaultSlippage: number("DEFAULT_SLIPPAGE", 0.1),
  defaultGasFeeDelta: number("DEFAULT_GAS_FEE_DELTA", 5),
  defaultMaxFeePerGas: number("DEFAULT_MAX_FEE_PER_GAS", 100),
  simulatorTaskTimeoutSecs: number("SIMULATOR_TASK_TIMEOUT_SECS", 30),
  simulatorTaskPollIntervalMs: number("SIMULATOR_TASK_POLL_INTERVAL_MS", 500),

  // Mode
  liveMode: process.env.LIVE_MODE?.toLowerCase() === "true",
  recoveryOnStart:
    (process.env.LIVE_RECOVERY_ON_START ?? "true").toLowerCase() === "true",
  liveDbPath: process.env.LIVE_DB_PATH ?? "./data/live_trading.json",

  // Observability
  logLevel: process.env.LOG_LEVEL ?? "info",
};

// Validate live-mode configuration at load time
if (CONFIG.liveMode) {
  if (!CONFIG.walletId || !CONFIG.walletAddress) {
    throw new Error(
      "[config] LIVE_MODE=true requires LIVE_WALLET_ID and LIVE_WALLET_ADDRESS to be set",
    );
  }
}
