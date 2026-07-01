import { startTelegramListener } from "./telegram/telegram_listener";
import { pairUpdate$ } from "./market/dbotx_data_ws";
import { concat, from, ignoreElements, merge, tap } from "rxjs";
import { simulatorAccount$ } from "./simulator/account";
import { simFastBuy } from "./simulator/fast_buy_sell";
/**
 * Start Telegram client.
 */
// const startup$ = from(startTelegramListener()).pipe(
//   tap(() => {
//     console.log("[main] Telegram listener started");
//   }),
//   ignoreElements(),
// );

/**
 * Live pair updates from DBotX websocket.
 */
// const pairConsumer$ = pairUpdate$.pipe(
//   tap((update) => {
//     console.log(`[PRICE] ${update.pair} $${update.priceUsd}`);
//   }),
// );

/**
 * Application event bus.
 */
// concat(startup$, pairConsumer$).subscribe({
//   error(error) {
//     console.error("[main] fatal error:", error);

//     process.exit(1);
//   },
// });

// Example Usage

async function main() {
  // simulatorAccount$.subscribe((account) => {
  //   console.log(
  //     `[SIM] Balance=${account.balance} SOL ` +
  //       `PnL=${account.changeAll * 100}% ` +
  //       `Tokens=${account.holdTokens}`,
  //   );
  // });

  const response = await simFastBuy({
    pair: "Fux28yJDBubYqSJcz3ZJtPZrY5MYVHHFxfZhUoKy9n5r",

    amountOrPercent: 0.1,

    stopEarnGroup: [
      {
        pricePercent: 0.2,
        amountPercent: 0.5,
      },
      {
        pricePercent: 0.8,
        amountPercent: 1,
      },
    ],

    stopLossGroup: [
      {
        pricePercent: 0.2,
        amountPercent: 0.5,
      },
      {
        pricePercent: 0.8,
        amountPercent: 1,
      },
    ],

    priorityFee: "",
    slippage: 0.1,
  });

  console.log("[SIM] simFastBuy response:", response);
  //   [SIM BUY] Fux28yJDBubYqSJcz3ZJtPZrY5MYVHHFxfZhUoKy9n5r -> mr2qpc810wzhxy
  //   [SIM] simFastBuy response: mr2qpc810wzhxy
}

main().catch((e) => console.error(`[main] fatal error: `, e));
