/**
 * simulator/account.ts
 *
 * DBotX simulator account stream.
 *
 * Exposes:
 *  - refreshAccount$  — manual refresh trigger (Subject)
 *  - simulatorAccount$ — live account observable (auto-polls every 60s)
 *  - fetchSimulatorAccount() — raw fetch function
 *
 * Errors are caught inside each switchMap so the stream never
 * dies. On error the tick is silently dropped; the shareReplay
 * retains the last known good value for late subscribers.
 */

import { Subject, from, merge, timer, EMPTY } from "rxjs";
import { switchMap, shareReplay, catchError, tap } from "rxjs/operators";
import { CONFIG } from "../config";

export interface SimulatorAccount {
  balance: number;
  change24h: number;
  changeAll: number;
  holdTokens: number;
}

interface AccountResponse {
  err: boolean;
  res: {
    balance: string;
    change24h: number;
    changeAll: number;
    holdTokens: number;
  };
}

export const refreshAccount$ = new Subject<void>();

const { baseUrl } = CONFIG;

export async function fetchSimulatorAccount(): Promise<SimulatorAccount> {
  const response = await fetch(`${baseUrl}/simulator/sim_account`, {
    headers: { "x-api-key": CONFIG.dbotxApiKey },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const body = (await response.json()) as AccountResponse;

  if (body.err) {
    throw new Error("API returned err: true");
  }

  return {
    balance: parseFloat(body.res.balance),
    change24h: body.res.change24h,
    changeAll: body.res.changeAll,
    holdTokens: body.res.holdTokens,
  };
}

export let latestAccount: SimulatorAccount | null = null;

/* Manual refresh — triggerd by refreshAccount$.next() */
const manualRefresh$ = refreshAccount$.pipe(
  switchMap(() =>
    from(fetchSimulatorAccount()).pipe(
      tap((a) => { latestAccount = a; }),
      catchError((err) => {
        console.error("[simulator] Account fetch failed:", err);
        return EMPTY;
      }),
    ),
  ),
);

/* Auto-poll every 60s (first tick delayed so it doesn't fire on cold load) */
const polling$ = timer(60_000, 60_000).pipe(
  switchMap(() =>
    from(fetchSimulatorAccount()).pipe(
      tap((a) => { latestAccount = a; }),
      catchError((err) => {
        console.error("[simulator] Account fetch failed:", err);
        return EMPTY;
      }),
    ),
  ),
);

export const simulatorAccount$ = merge(manualRefresh$, polling$).pipe(
  shareReplay({ bufferSize: 1, refCount: true }),
);
