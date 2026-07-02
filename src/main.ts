import "./simulator/position_manager";
import { startPersistence, stopPersistence } from "./analytics/trades_repository";
import { startReporter, stopReporter } from "./telegram/telegram_bot_reporter";

import { startTelegramListener } from "./telegram/telegram_listener";
import { pairUpdate$ } from "./market/dbotx_data_ws";
import { simulatorAccount$ } from "./simulator/account";
import { positionEvent$ } from "./simulator/position_manager";
import { tap } from "rxjs";

async function start(): Promise<void> {
  /*
   * Start analytics persistence.
   */
  startPersistence();

  /*
   * Start Telegram reporter (real-time alerts + periodic summaries).
   */
  startReporter();

  /*
   * Start Telegram listener (login prompt via stdin).
   */
  await startTelegramListener();

  /*
   * Log live WS price updates.
   */
  pairUpdate$
    .pipe(
      tap((u) => {
        if (u.priceUsd) {
          console.log(`[PRICE] ${u.pair} $${u.priceUsd.toFixed(8)}`);
        }
      }),
    )
    .subscribe();

  /*
   * Log position lifecycle events.
   */
  positionEvent$
    .pipe(
      tap((ev) => {
        const p = ev.position;
        if (ev.type === "opened") {
          console.log(
            `[POS] Opened ${p.tokenName} @ ${p.pair} with ${p.sizeSol} SOL`,
          );
        } else if (ev.type === "closed") {
          console.log(
            `[POS] Closed ${p.tokenName}: ${ev.closeReason ?? "?"}` +
              ` | PnL: ${p.currentProfitPercent?.toFixed(2) ?? "?"}%` +
              ` ($${p.currentProfitUsd?.toFixed(2) ?? "?"})`,
          );
        }
      }),
    )
    .subscribe();

  /*
   * Log periodic account snapshots.
   */
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
