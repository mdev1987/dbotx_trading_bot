import "@dotenvx/dotenvx/config";

export interface PartialTpTier {
  pct: number;
  at: number;
}

/* ------------------------------------------------------------------ */
/*  Env var helpers                                                   */
/* ------------------------------------------------------------------ */

function required(key: string): string {
  const val = process.env[key];
  if (!val) {
    throw new Error(
      `[config] Missing required environment variable: ${key}`,
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
  if (!Number.isFinite(n)) {
    throw new Error(
      `[config] Invalid number for ${key}: "${raw}"`,
    );
  }
  return n;
}

function parsePartialTpTiers(raw: string | undefined): PartialTpTier[] {
  if (!raw) return [];

  return raw.split(",").flatMap((part) => {
    const [pctStr, atStr] = part.split("@");
    const pct = Number(pctStr) / 100;
    const at = Number(atStr) / 100;

    if (!Number.isFinite(pct) || !Number.isFinite(at) || pct <= 0 || at <= 0) {
      throw new Error(
        `[config] invalid partial TP tier: "${part}" – expected format "pct%@at%", got pct="${pctStr}" at="${atStr}"`,
      );
    }

    return [{ pct, at }];
  });
}

export const CONFIG = {
  dbotxApiKey: required("DBOTX_API_KEY"),
  wsUrl: required("DBOTX_WS_URL"),
  baseUrl: required("DBOTX_BASE_URL"),
  servapiBaseUrl: process.env.SERVAPI_BASE_URL ?? "https://servapi.dbotx.com",

  ttlSignalSeconds: number("TTL_SIGNAL_SECONDS", 600),
  maxPositions: number("MAX_POSITIONS", 5),
  ttlPositionSeconds: number("TTL_POSITION_SECONDS", 600),
  positionSize: number("POSITION_SIZE_SOL", 0.1),

  stopLossPct: number("PAPER_STOP_LOSS_PERCENT") / 100,
  trailingActivationPct: number("PAPER_TRAILING_ACTIVATION_PERCENT") / 100,
  trailingDistancePct: number("PAPER_TRAILING_STOP_PERCENT") / 100,

  partialTpTiers: parsePartialTpTiers(process.env.PARTIAL_TP_TIERS),

  backstopTpPct:
    Number(
      process.env.PAPER_BACKSTOP_TP_PERCENT ??
        process.env.PAPER_TAKE_PROFIT_PERCENT,
    ) / 100,

  maxSlippageExitPct: number("PAPER_MAX_SLIPPAGE_EXIT_PERCENT") / 100,

  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  reportIntervalMinutes: number("TELEGRAM_REPORT_INTERVAL_MINUTES", 5),

  telegramApiId: process.env.TELEGRAM_API_ID,
  telegramApiHash: process.env.TELEGRAM_API_HASH,
  telegramChannelUserName: process.env.TELEGRAM_CHANNEL_USERNAME,
  telegramChannelId: process.env.TELEGRAM_CHANNEL_ID,

  sqlitePath: required("SQLITE_PATH"),

  dailyLossLimitUsd: number("DAILY_LOSS_LIMIT_USD", 0),

  logLevel: process.env.LOG_LEVEL ?? "info",
};
