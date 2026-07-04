// Reactive DBotX simulator account stream with manual refresh and auto-polling
import { Subject, from, merge, timer, EMPTY } from "rxjs"; // RxJS core types
import { switchMap, shareReplay, catchError, tap } from "rxjs/operators"; // RxJS operators
import { CONFIG } from "../config"; // App configuration

/**
 * Shape of the simulator account data
 */
export interface SimulatorAccount {
  balance: number; // Current account balance in USD
  change24h: number; // Percentage change over 24 hours
  changeAll: number; // Percentage change since account creation
  holdTokens: number; // Number of distinct tokens held
}

/**
 * Raw response shape from the simulator API
 */
interface AccountResponse {
  err: boolean; // Error flag
  res: {
    balance: string; // Balance as a string (to handle large numbers)
    change24h: number; // 24h change percentage
    changeAll: number; // All-time change percentage
    holdTokens: number; // Number of held tokens
  };
}

/**
 * Subject to trigger a manual account refresh from anywhere in the app
 */
export const refreshAccount$ = new Subject<void>();

// Extract the base URL from config
const { baseUrl } = CONFIG;

/**
 * Fetch the simulator account directly from the API
 * @returns The parsed simulator account data
 */
export async function fetchSimulatorAccount(): Promise<SimulatorAccount> {
  try {
    // GET request to the simulator account endpoint
    const response = await fetch(`${baseUrl}/simulator/sim_account`, {
      headers: { "x-api-key": CONFIG.dbotxApiKey },
    });

    // Throw on HTTP-level errors
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // Parse the JSON body
    const body = (await response.json()) as AccountResponse;

    // Throw on API-level errors
    if (body.err) {
      throw new Error("API returned err: true");
    }

    // Convert the response to our domain type (parse balance from string)
    return {
      balance: parseFloat(body.res.balance),
      change24h: body.res.change24h,
      changeAll: body.res.changeAll,
      holdTokens: body.res.holdTokens,
    };
  } catch (error) {
    // Rethrow network/parsing errors for upstream catchError handling
    throw error;
  }
}

/**
 * Synchronous snapshot of the latest account value (null before first fetch)
 */
export let latestAccount: SimulatorAccount | null = null;

/**
 * Manual refresh stream — triggers on refreshAccount$.next()
 */
const manualRefresh$ = refreshAccount$.pipe(
  // switchMap: on each emission, unsubscribe from the previous inner observable
  // (cancelling any in-flight fetch) and subscribe to the new one
  switchMap(() =>
    // from: convert the Promise returned by fetchSimulatorAccount into an Observable
    from(fetchSimulatorAccount()).pipe(
      // tap: perform the side-effect of caching the latest account value
      tap((a) => {
        latestAccount = a;
      }),
      // catchError: swallow errors so the stream stays alive; log and emit EMPTY
      catchError((err) => {
        console.error("[simulator] Account fetch failed:", err);
        return EMPTY;
      }),
    ),
  ),
);

/**
 * Auto-polling stream — first tick delayed to avoid firing on cold start
 */
const polling$ = timer(CONFIG.accountPollIntervalMs, CONFIG.accountPollIntervalMs).pipe(
  // timer: emits 0 after the first delay, then emits sequentially at the interval
  // switchMap: on each timer tick, cancel any pending fetch and start a new one
  switchMap(() =>
    // from: lift the Promise into the Observable world
    from(fetchSimulatorAccount()).pipe(
      // tap: write the freshest value into the synchronous cache
      tap((a) => {
        latestAccount = a;
      }),
      // catchError: prevent a failing fetch from killing the poll stream
      catchError((err) => {
        console.error("[simulator] Account fetch failed:", err);
        return EMPTY;
      }),
    ),
  ),
);

/**
 * Merged account stream: emits from both manual refreshes and auto-polls
 */
export const simulatorAccount$ = merge(manualRefresh$, polling$).pipe(
  // merge: interleave emissions from both manual-refresh and auto-poll sources
  // shareReplay: multicast the stream and replay the latest value (bufferSize: 1)
  //   to late subscribers; refCount disconnects upstream when count drops to 0
  shareReplay({ bufferSize: 1, refCount: true }),
);
