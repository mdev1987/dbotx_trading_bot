import {
  subscribeToken as dexSubscribeToken,
  unsubscribeToken as dexUnsubscribeToken,
  disconnectDexScreener,
  dexScreenerPriceUpdateEvent$,
  dexScreenerState$,
} from "./data_stream/dexscreener_data_stream";

const TOKEN_CA = "3SZrdW1NRQJDKmcT813UP1ZXy9gKsUKqz9utfQko7777";
const LP_PAIR = "Hp4eK45oUXJK67HdqirsZtiyVnJqosbw9KvrPXfe1xCo";
const RUN_DURATION_MS = 5 * 60 * 1000;

const startTime = Date.now();
let dexCount = 0;

function ts(): string {
  const elapsed = Date.now() - startTime;
  const min = Math.floor(elapsed / 60000);
  const sec = Math.floor((elapsed % 60000) / 1000);
  return `${min}:${String(sec).padStart(2, "0")}`;
}

/* -------------------------------------------------------------------------- */
/*  DexScreener (REST polling — /tokens/v1/solana/{addrs})                    */
/* -------------------------------------------------------------------------- */

dexScreenerState$.subscribe((state) => {
  if (state === "polling") {
    console.log(`[${ts()}] [DexScreener] Polling started`);
  }
});

dexScreenerPriceUpdateEvent$.subscribe((event) => {
  dexCount++;
  console.log(
    `[${ts()}] [DexScreener] ${event.pair.slice(0, 8)} ` +
      `token=${event.token.slice(0, 8)} ` +
      `price=${event.priceUsd.toExponential(4)} ` +
      `native=${event.priceNative.toExponential(4)} ` +
      `liq=${event.liquidityUsd} ` +
      `dex=${event.dexId}`,
  );
});

/* -------------------------------------------------------------------------- */
/*  Main                                                                      */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  console.log(`[${ts()}] ============================`);
  console.log(`[${ts()}] DexScreener Price Track Test`);
  console.log(`[${ts()}]   CA:  ${TOKEN_CA}`);
  console.log(`[${ts()}]   LP:  ${LP_PAIR}`);
  console.log(`[${ts()}]   Duration: ${RUN_DURATION_MS / 1000}s`);
  console.log(`[${ts()}]   Poll interval: 200ms (max 5 rps = 300 rpm)`);
  console.log(`[${ts()}] ============================`);

  dexSubscribeToken(TOKEN_CA, "solana", LP_PAIR);

  await new Promise<void>((resolve) => {
    const handle = setTimeout(resolve, RUN_DURATION_MS);
    process.on("SIGINT", () => {
      clearTimeout(handle);
      resolve();
    });
  });

  dexUnsubscribeToken(TOKEN_CA);
  disconnectDexScreener();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const rate = (dexCount / Number(elapsed)).toFixed(1);
  console.log(`[${ts()}] ============================`);
  console.log(`[${ts()}] Test Complete (${elapsed}s)`);
  console.log(`[${ts()}]   DexScreener updates: ${dexCount}`);
  console.log(`[${ts()}]   Avg rate: ${rate} req/s`);
  console.log(`[${ts()}] ============================`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[Fatal]", err);
  process.exit(1);
});
