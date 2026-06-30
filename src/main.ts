/**
 * Paper trader – entry point.
 *
 * Initialises the database, connects to DBotX, and
 * starts the TTL engine. The process runs indefinitely
 * collecting market data and executing paper trades.
 */

import { initializeDatabase, db } from "./db";
import { connect, disconnect } from "./dbotx_client";
import { startTtlEngine, stopTtlEngine } from "./ttl_engine";
import { startReporter, stopReporter } from "./reporter";
import { CONFIG } from "./config";

function handleShutdown(): void {
  console.log("\n[main] shutting down...");
  stopTtlEngine();
  stopReporter();
  disconnect();

  /*
   * WAL checkpoints are flushed automatically on close.
   * Explicit checkpoint for safety.
   */
  db.run("PRAGMA wal_checkpoint(TRUNCATE);");
  db.close();

  console.log("[main] goodbye");
  process.exit(0);
}

async function main(): Promise<void> {
  console.log("=".repeat(50));
  console.log("  DBotX Paper Trader (research edition)");
  console.log("=".repeat(50));
  console.log(`  Wallet:     ${CONFIG.startingBalance} SOL`);
  console.log(`  Position:   ${CONFIG.positionSize} SOL`);
  console.log(`  Max trades: ${CONFIG.maxOpenTrades}`);
  console.log(`  TTL:        ${CONFIG.ttlSeconds}s`);
  console.log(`  TP:         ${(CONFIG.backstopTpPct * 100).toFixed(0)}%`);
  console.log(`  SL:         ${(CONFIG.stopLossPct * 100).toFixed(0)}%`);
  console.log(`  Trail dist: ${(CONFIG.trailingDistancePct * 100).toFixed(0)}%`);
  console.log(`  Trail act:  ${(CONFIG.trailingActivationPct * 100).toFixed(0)}%`);
  console.log(`  Partial TP: ${CONFIG.partialTpTiers.length > 0 ? CONFIG.partialTpTiers.map(t => `${(t.pct * 100).toFixed(0)}%@${(t.at * 100).toFixed(0)}%`).join(", ") : "none"}`);
  console.log(`  Max slip:   ${(CONFIG.maxSlippageExitPct * 100).toFixed(0)}%`);
  console.log(`  Telegram:   ${CONFIG.telegramBotToken ? "enabled" : "disabled"}`);
  console.log(`  DB:         ${CONFIG.sqlitePath}`);
  console.log("=".repeat(50));

  /* initialise persistence */
  initializeDatabase();
  console.log("[main] database ready");

  /* start the exit-condition checker */
  startTtlEngine();

  /* connect to DBotX websocket */
  connect();

  /* start Telegram reporter */
  startReporter();

  /* graceful shutdown handlers */
  process.on("SIGINT", handleShutdown);
  process.on("SIGTERM", handleShutdown);
}

main().catch((err) => {
  console.error("[main] fatal error:", err);
  process.exit(1);
});
