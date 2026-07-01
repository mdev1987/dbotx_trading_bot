/* ============================================================
 * simulator/account.ts
 *
 * DBotX simulator account module.
 *
 * Responsibilities:
 *
 * - Fetch simulator account information
 * - Expose refresh trigger
 * - Expose account observable
 *
 * ============================================================
 */

import { Subject, from, merge, timer } from "rxjs";

import { switchMap, shareReplay } from "rxjs/operators";

import { CONFIG } from "../config";

/* ============================================================
 * Types
 * ============================================================
 */

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

/* ============================================================
 * Refresh trigger
 * ============================================================
 */

export const refreshAccount$ = new Subject<void>();

/* ============================================================
 * Fetch account
 * ============================================================
 */
const { baseUrl } = CONFIG;
export async function fetchSimulatorAccount(): Promise<SimulatorAccount> {
  const response = await fetch(`${baseUrl}/simulator/sim_account`, {
    headers: {
      "x-api-key": CONFIG.dbotxApiKey,
    },
  });

  if (!response.ok) {
    console.error(
      `[simulator] HTTP error ${response.status}:`,
      response.statusText,
    );
    throw new Error(`Simulator account request failed (${response.status})`);
  }

  const simulateAccountResponse: AccountResponse =
    (await response.json()) as AccountResponse;

  if (simulateAccountResponse.err) {
    throw new Error("DBotX returned an error");
  }

  return {
    ...simulateAccountResponse.res,
    balance: parseFloat(simulateAccountResponse.res.balance),
  };
}

/* ============================================================
 * Manual refresh stream
 * ============================================================
 */

const manualRefresh$ = refreshAccount$.pipe(
  switchMap(() => from(fetchSimulatorAccount())),
);

/* ============================================================
 * Automatic refresh every 60 seconds
 * ============================================================
 */

const polling$ = timer(0, 60_000).pipe(
  switchMap(() => from(fetchSimulatorAccount())),
);

/* ============================================================
 * Account stream
 * ============================================================
 */

export const simulatorAccount$ = merge(manualRefresh$, polling$).pipe(
  shareReplay({
    bufferSize: 1, // Share the latest value
    refCount: true, // Share the latest value with all subscribers
  }),
);
