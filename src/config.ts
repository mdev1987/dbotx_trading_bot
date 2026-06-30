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
      console.warn(`[config] ignoring invalid partial TP tier: "${part}"`);
      return [];
    }

    return [{ pct, at }];
  });
}

export const CONFIG = {
  dbotxApiKey: process.env.DBOTX_API_KEY!,
  wsUrl: process.env.DBOTX_WS_URL!,

  startingBalance: Number(process.env.PAPER_STARTING_BALANCE_SOL),
  positionSize: Number(process.env.PAPER_POSITION_SIZE_SOL),
  maxOpenTrades: Number(process.env.PAPER_MAX_OPEN_TRADES),

  ttlSeconds: Number(process.env.PAPER_TTL_SECONDS),
  stopLossPct: Number(process.env.PAPER_STOP_LOSS_PERCENT) / 100,

  trailingActivationPct:
    Number(process.env.PAPER_TRAILING_ACTIVATION_PERCENT) / 100,

  trailingDistancePct:
    Number(process.env.PAPER_TRAILING_STOP_PERCENT) / 100,

  partialTpTiers: parsePartialTpTiers(process.env.PARTIAL_TP_TIERS),

  backstopTpPct:
    Number(
      process.env.PAPER_BACKSTOP_TP_PERCENT
        ?? process.env.PAPER_TAKE_PROFIT_PERCENT,
    ) / 100,

  maxSlippageExitPct:
    Number(process.env.PAPER_MAX_SLIPPAGE_EXIT_PERCENT) / 100,

  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  reportIntervalMinutes: Number(process.env.TELEGRAM_REPORT_INTERVAL_MINUTES ?? "5"),

  sqlitePath: process.env.SQLITE_PATH!,

  snapshotIntervalSeconds: Number(process.env.SNAPSHOT_INTERVAL_SECONDS),
  saveRawJson: process.env.SAVE_RAW_JSON === "true",

  logLevel: process.env.LOG_LEVEL ?? "info",
} as const;
