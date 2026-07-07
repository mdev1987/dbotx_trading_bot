/**
 * Live trading configuration — thin overlay on top of CONFIG.
 *
 * Every shared value (sizing, limits, TP/SL, polling, etc.) is delegated to
 * the single source of truth in `src/config.ts`.  Only keys that are truly
 * live-specific (wallet, Jito, watchdog, swap-order polling, etc.) are
 * defined locally with their own env-var fallback.
 */
import "@dotenvx/dotenvx/config";
import { CONFIG } from "../config";

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

export const LIVE_CONFIG = {
  // ── Mode ─────────────────────────────────────────────────────────────
  liveMode: CONFIG.liveMode,
  liveBuyEnabled: (process.env.LIVE_BUY_ENABLED ?? "true").toLowerCase() === "true",

  // ── Shared (delegated to CONFIG) ─────────────────────────────────────
  dbotxApiKey: CONFIG.dbotxApiKey,
  baseUrl: CONFIG.baseUrl,
  dataBaseUrl: CONFIG.dataBaseUrl,
  tradeWsUrl: process.env.LIVE_TRADE_WS_URL ?? "wss://api-bot-v1.dbotx.com/trade/ws/",

  // ── Wallet ───────────────────────────────────────────────────────────
  walletId: (() => {
    const v = process.env.LIVE_WALLET_ID;
    if (!v) throw new Error("[live/config] Missing required env: LIVE_WALLET_ID");
    return v;
  })(),
  walletAddress: (() => {
    const v = process.env.LIVE_WALLET_ADDRESS;
    if (!v) throw new Error("[live/config] Missing required env: LIVE_WALLET_ADDRESS");
    return v;
  })(),

  // ── Sizing & Limits (delegated) ──────────────────────────────────────
  positionSize: CONFIG.positionSize,
  minPositionSol: CONFIG.minPositionSol,
  maxPositionSol: CONFIG.maxPositionSol,
  maxRiskPct: CONFIG.maxRiskPct,
  maxPositions: CONFIG.maxPositions,
  signalQueueSize: CONFIG.signalQueueSize,
  signalQueueTtlSecs: CONFIG.signalQueueTtlSecs,
  baseTtlSecs: CONFIG.baseTtlSecs,
  minProfitForTtlExtensionPct: CONFIG.minProfitForTtlExtensionPct,
  maxTtlSecs: CONFIG.maxTtlSecs,

  // ── TP/SL (delegated to CONFIG; property name differs between modes) ─
  partialTpEnabled: CONFIG.partialTpEnabled,
  partialTpTiers: CONFIG.partialTpTiers,
  backstopTpPct: CONFIG.backstopTpPct,
  stopLossPct: CONFIG.stopLossPct,
  trailingActivationPct: CONFIG.trailingActivationPct,
  trailingStopPct: CONFIG.trailingDistancePct,
  trailingTpPct: CONFIG.trailingTpDistancePct,
  maxSlippageExitPct: CONFIG.maxSlippageExitPct,

  // ── Live execution ───────────────────────────────────────────────────
  jitoEnabled: (process.env.LIVE_JITO_ENABLED ?? "true").toLowerCase() === "true",
  jitoTip: number("LIVE_JITO_TIP", 0.0001),
  customFeeAndTip: (process.env.LIVE_CUSTOM_FEE_AND_TIP ?? "false").toLowerCase() === "true",
  priorityFee: process.env.LIVE_PRIORITY_FEE ?? "",
  maxSlippage: number("LIVE_MAX_SLIPPAGE", 0.1),
  concurrentNodes: number("LIVE_CONCURRENT_NODES", 2),
  retries: number("LIVE_RETRIES", 1),
  migrateSellPercent: number("LIVE_MIGRATE_SELL_PERCENT", 1),
  minDevSellPercent: number("LIVE_MIN_DEV_SELL_PERCENT", 0.5),
  devSellPercent: number("LIVE_DEV_SELL_PERCENT", 0),

  // ── PnL order lifecycle ─────────────────────────────────────────────
  pnlOrderExpireDeltaMs: number("LIVE_PNL_ORDER_EXPIRE_DELTA_MS", 43_200_000),
  pnlOrderExpireExecute: (process.env.LIVE_PNL_ORDER_EXPIRE_EXECUTE ?? "true").toLowerCase() === "true",
  pnlOrderUseMidPrice: (process.env.LIVE_PNL_ORDER_USE_MID_PRICE ?? "true").toLowerCase() === "true",

  // ── Polling & timing (delegated) ─────────────────────────────────────
  swapOrderPollMs: number("LIVE_SWAP_ORDER_POLL_MS", 2_000),
  maxSwapOrderPollAttempts: number("LIVE_MAX_SWAP_ORDER_POLL_ATTEMPTS", 30),
  accountPollIntervalMs: CONFIG.accountPollIntervalMs,
  expiryCheckMs: CONFIG.expiryCheckMs,
  pendingBuyTtlMs: CONFIG.pendingBuyTtlMs,
  wsHeartbeatIntervalMs: CONFIG.wsHeartbeatIntervalMs,
  wsReconnectDelayMs: CONFIG.wsReconnectDelayMs,
  httpMaxRetries: CONFIG.httpMaxRetries,
  httpBaseDelayMs: CONFIG.httpBaseDelayMs,
  httpTimeoutMs: CONFIG.httpTimeoutMs,

  // ── Recovery ─────────────────────────────────────────────────────────
  recoveryOnStart: (process.env.LIVE_RECOVERY_ON_START ?? "true").toLowerCase() === "true",
  liveDbPath: process.env.LIVE_DB_PATH ?? "./data/live_trading.sqlite",

  // ── Duplicate protection ─────────────────────────────────────────────
  duplicateLockWindowMs: CONFIG.duplicateLockWindowMs,

  // ── Emergency stop ───────────────────────────────────────────────────
  stopTradingPath: CONFIG.stopTradingPath,
  maxConsecutiveApiFailures: CONFIG.maxConsecutiveApiFailures,
  maxWsDisconnects: number("MAX_WS_DISCONNECTS", 5),

  // ── Portfolio limits ─────────────────────────────────────────────────
  maxTotalSolDeployed: CONFIG.maxTotalSolDeployed,
  maxPortfolioExposurePct: CONFIG.maxPortfolioExposurePct,
  maxBuysPerMinute: CONFIG.maxBuysPerMinute,
  maxBuysPerHour: CONFIG.maxBuysPerHour,
  dailyLossLimitUsd: CONFIG.dailyLossLimitUsd,
  reconciliationIntervalMs: CONFIG.reconciliationIntervalMs,

  // ── Watchdog ─────────────────────────────────────────────────────────
  watchdogIntervalMs: number("WATCHDOG_INTERVAL_MS", 15_000),
  watchdogWsStaleMs: number("WATCHDOG_WS_STALE_MS", 60_000),
  watchdogBalanceStaleMs: number("WATCHDOG_BALANCE_STALE_MS", 120_000),
  watchdogPriceStaleMs: number("WATCHDOG_PRICE_STALE_MS", 60_000),

  // ── Price sanity ─────────────────────────────────────────────────────
  maxPriceDeviationPct: CONFIG.maxPriceDeviationPct,

  // ── Telegram (delegated) ─────────────────────────────────────────────
  telegramBotToken: CONFIG.telegramBotToken,
  telegramChatId: CONFIG.telegramChatId,
};
