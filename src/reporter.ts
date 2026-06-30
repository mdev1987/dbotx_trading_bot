/**
 * Reporter – builds a periodic performance digest and sends it to Telegram.
 *
 * Runs on a configurable interval (default 5 min) and reports:
 *   • PnL, balance, win/loss totals
 *   • Exit reason counts (TTL, TP, SL, partial TP, slippage)
 *   • Best and worst signal profiles
 */

import { Bot } from "grammy";
import { db, getWalletBalance } from "./db";
import { CONFIG } from "./config";
import { summary, bestSignalParameters, worstSignalParameters } from "./analytics";
import type { SummaryReport, SignalProfile } from "./analytics";

let timer: ReturnType<typeof setInterval> | null = null;
let bot: Bot | null = null;

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

interface ExitCounts {
  ttl: number;
  tp: number;
  sl: number;
  trailing: number;
  slippage: number;
  manual: number;
  partialFills: number;
}

async function getExitCounts(): Promise<ExitCounts> {
  const rows = await db`
    SELECT exit_reason, COUNT(*) AS cnt
    FROM trades
    WHERE open = 0 AND exit_reason IS NOT NULL
    GROUP BY exit_reason
  ` as { exit_reason: string; cnt: number }[];

  const map = new Map(rows.map((r) => [r.exit_reason, r.cnt]));

  const [partialRow] = await db`
    SELECT COUNT(*) AS c FROM partial_fills
  ` as { c: number }[];

  return {
    ttl: map.get("TTL") ?? 0,
    tp: map.get("TAKE_PROFIT") ?? 0,
    sl: map.get("STOP_LOSS") ?? 0,
    trailing: map.get("TRAILING_STOP") ?? 0,
    slippage: map.get("SLIPPAGE") ?? 0,
    manual: map.get("MANUAL") ?? 0,
    partialFills: partialRow?.c ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Report builder
// ---------------------------------------------------------------------------

function sol(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(4)} SOL`;
}

function pct(v: number): string {
  return `${(v * 100).toFixed(2)}%`;
}

function profileLine(label: string, profile: SignalProfile | null): string {
  if (!profile) return `   <i>no data</i>`;
  return (
    `   📊 <b>${label}</b>  avg PnL: ${pct(profile.avgPnlPercent)}  (n=${profile.tradeCount})\n` +
    `   Holders: ${profile.avgHolders?.toFixed(0) ?? "?"}  ` +
    `MCap: ${profile.avgMarketCapUsd != null ? `$${(profile.avgMarketCapUsd / 1_000).toFixed(0)}k` : "?"}  ` +
    `Liq: ${profile.avgLiquiditySol?.toFixed(2) ?? "?"} SOL\n` +
    `   Top10: ${profile.avgTop10 != null ? `${(profile.avgTop10 * 100).toFixed(1)}%` : "?"}  ` +
    `Dev: ${profile.avgDevHoldings != null ? `${(profile.avgDevHoldings * 100).toFixed(1)}%` : "?"}  ` +
    `Δ1m: ${profile.avgPriceChange1m != null ? pct(profile.avgPriceChange1m) : "?"}`
  );
}

async function buildReport(): Promise<string> {
  const s: SummaryReport = await summary();
  const exitCounts = await getExitCounts();
  const balance = await getWalletBalance();
  const best = await bestSignalParameters();
  const worst = await worstSignalParameters();

  const totalWonSol =
    s.totalPnlSol > 0 ? s.totalPnlSol : 0;
  const totalLostSol =
    s.totalPnlSol < 0 ? Math.abs(s.totalPnlSol) : 0;

  const lines: string[] = [];

  lines.push(`<b>🤖 Paper Trader Report</b>`);
  lines.push(`<code>${new Date().toISOString()}</code>`);
  lines.push(``);

  // --- PnL & Balance ---
  const pnlEmoji = s.totalPnlSol >= 0 ? "🟢" : "🔴";
  lines.push(
    `${pnlEmoji} <b>PnL:</b> ${sol(s.totalPnlSol)}  ` +
    `(${s.totalPnlSol >= 0 ? "+" : ""}${pct(s.avgPnlPercent)})`,
  );
  lines.push(`💰 <b>Balance:</b> ${balance.toFixed(4)} SOL`);
  lines.push(``);

  // --- Win / Loss stats ---
  const wr = s.winRate * 100;
  lines.push(
    `✅ <b>Wins:</b> ${s.wins}  ` +
    `❌ <b>Losses:</b> ${s.losses}  ` +
    `<b>WR:</b> ${wr.toFixed(1)}%`,
  );
  lines.push(
    `🏆 <b>Best:</b> ${pct(s.bestTrade)}  ` +
    `🪤 <b>Worst:</b> ${pct(s.worstTrade)}`,
  );
  lines.push(
    `📈 <b>Won:</b> ${sol(totalWonSol)}  ` +
    `📉 <b>Lost:</b> ${sol(totalLostSol)}`,
  );
  lines.push(``);

  // --- Trade counts ---
  lines.push(
    `📊 <b>Tx:</b> ${s.totalTrades}  ` +
    `🟢 <b>Open:</b> ${s.openTrades}  ` +
    `🔵 <b>Closed:</b> ${s.closedTrades}`,
  );
  lines.push(
    `⏱ <b>TTL:</b> ${exitCounts.ttl}  ` +
    `🎯 <b>TP:</b> ${exitCounts.tp}  ` +
    `🛑 <b>SL:</b> ${exitCounts.sl}  ` +
    `🔁 <b>Trail:</b> ${exitCounts.trailing}  ` +
    `💥 <b>Slip:</b> ${exitCounts.slippage}`,
  );
  lines.push(
    `📦 <b>Partial TP fills:</b> ${exitCounts.partialFills}`,
  );
  lines.push(``);

  // --- Best / worst signal profiles ---
  lines.push(`<b>🏆 Best signal profile</b>`);
  lines.push(profileLine("", best));
  lines.push(``);
  lines.push(`<b>🪤 Worst signal profile</b>`);
  lines.push(profileLine("", worst));

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

async function sendReport(): Promise<void> {
  if (!bot || !CONFIG.telegramChatId) return;

  try {
    const text = await buildReport();
    await bot.api.sendMessage(CONFIG.telegramChatId, text, {
      parse_mode: "HTML",
    });
  } catch (err) {
    console.error("[reporter] failed to send:", err);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function startReporter(): void {
  if (!CONFIG.telegramBotToken) {
    console.log("[reporter] disabled – TELEGRAM_BOT_TOKEN not set");
    return;
  }

  bot = new Bot(CONFIG.telegramBotToken);
  const intervalMs = CONFIG.reportIntervalMinutes * 60 * 1_000;

  console.log(
    `[reporter] started (every ${CONFIG.reportIntervalMinutes} min)`,
  );

  /* send first report after a short delay so the bot boots fully */
  setTimeout(() => sendReport(), 10_000);

  timer = setInterval(sendReport, intervalMs);
}

export function stopReporter(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  console.log("[reporter] stopped");
}
