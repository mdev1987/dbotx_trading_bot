import "./simulator/position_manager";
import { startPersistence, stopPersistence } from "./analytics/trades_repository";
import { startReporter, stopReporter } from "./telegram/telegram_bot_reporter";
import { startTelegramListener } from "./telegram/telegram_listener";
import { simulatorAccount$ } from "./simulator/account";
import { tap } from "rxjs";

async function start(): Promise<void> {
  startPersistence();
  startReporter();
  await startTelegramListener();

  simulatorAccount$
    .pipe(
      tap((acct) => {
        console.log(
          `[ACCT] Balance=${acct.balance.toFixed(3)} SOL` +
            ` | PnL=${(acct.changeAll * 100).toFixed(2)}%` +
            ` | Tokens=${acct.holdTokens}`,
        );
      }),
    )
    .subscribe();
}

start().catch((err) => {
  console.error("[main] Startup failed:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("[main] Unhandled rejection:", reason);
});

/*
 * Graceful shutdown — print final report on SIGINT.
 */
let _shuttingDown = false;

process.on("SIGINT", async () => {
  if (_shuttingDown) return;
  _shuttingDown = true;

  console.log("\n[main] Shutting down...");
  stopReporter();
  stopPersistence();

  try {
    const { generateReport, printReport } = await import("./analytics/reports");
    printReport(generateReport());
  } catch {
    /* Report generation is best-effort during shutdown */
  }

  process.exit(0);
});
