import "@dotenvx/dotenvx/config";

export interface PartialTpTier {
  pct: number;
  at: number;
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
  dbotxApiKey: process.env.DBOTX_API_KEY!,
  wsUrl: process.env.DBOTX_WS_URL!,
  baseUrl: process.env.DBOTX_BASE_URL!,
  // time to live (TTL) in seconds for signals
  ttlSignalSeconds: Number(process.env.TTL_SIGNAL_SECONDS ?? "600"), // 10 minutes = 10*60s
  maxPositions: Number(process.env.MAX_POSITIONS ?? "5"),
  // time to live (TTL) in seconds for open positions
  ttlPositionSeconds: Number(process.env.TTL_POSITION_SECONDS ?? "600"), // 10 minutes = 10*60s
  startingBalance: Number(process.env.SIMULATE_SOL_BALANCE ?? "5"), // 5 SOL
  positionSize: Number(process.env.POSITION_SIZE_SOL ?? "0.1"), // 0.1 SOL

  stopLossPct: Number(process.env.PAPER_STOP_LOSS_PERCENT) / 100,

  trailingActivationPct:
    Number(process.env.PAPER_TRAILING_ACTIVATION_PERCENT) / 100,

  trailingDistancePct: Number(process.env.PAPER_TRAILING_STOP_PERCENT) / 100,

  partialTpTiers: parsePartialTpTiers(process.env.PARTIAL_TP_TIERS),

  backstopTpPct:
    Number(
      process.env.PAPER_BACKSTOP_TP_PERCENT ??
        process.env.PAPER_TAKE_PROFIT_PERCENT,
    ) / 100,

  maxSlippageExitPct: Number(process.env.PAPER_MAX_SLIPPAGE_EXIT_PERCENT) / 100,

  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  reportIntervalMinutes: Number(
    process.env.TELEGRAM_REPORT_INTERVAL_MINUTES ?? "5",
  ),

  telegramApiId: process.env.TELEGRAM_API_ID,
  telegramApiHash: process.env.TELEGRAM_API_HASH,
  telegramChannelUserName: process.env.TELEGRAM_CHANNEL_USERNAME,
  telegramChannelId: process.env.TELEGRAM_CHANNEL_ID,

  sqlitePath: process.env.SQLITE_PATH!,

  snapshotIntervalSeconds: Number(process.env.SNAPSHOT_INTERVAL_SECONDS),
  saveRawJson: process.env.SAVE_RAW_JSON === "true",

  logLevel: process.env.LOG_LEVEL ?? "info",
};
