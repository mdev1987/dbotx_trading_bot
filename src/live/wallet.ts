/**
 * Wallet management module for live trading.
 *
 * Provides:
 *   • fetchWallets()      — list all wallets imported into DBotX
 *   • fetchBalance()      — SOL balance of the configured wallet
 *   • walletBalance$      — reactive RxJS stream
 */
import { Subject, from, merge, timer, EMPTY } from "rxjs";
import { switchMap, shareReplay, catchError, tap } from "rxjs/operators";
import { LIVE_CONFIG } from "./config";
import { getJson } from "./http";
import { markBalanceUpdate } from "./watchdog";
import type { LiveWalletInfo, LiveWalletBalanceResponse, LiveBalance } from "./types";

/**
 * Response shape from GET /account/wallets.
 */
interface WalletsResponse {
  err: boolean;
  res: LiveWalletInfo[];
}

/**
 * Fetch all wallets imported into the user's DBotX account.
 * Filters to Solana wallets.
 * @returns Array of wallet info objects.
 */
export async function fetchWallets(): Promise<LiveWalletInfo[]> {
  const url = `${LIVE_CONFIG.baseUrl}/account/wallets?type=solana&page=0&size=20`;
  const body = await getJson<WalletsResponse>(url);
  if (body.err) throw new Error("Wallet API returned err: true");
  return body.res;
}

/**
 * Resolve the configured wallet ID to its on-chain address.
 * Useful as a startup sanity check.
 * @returns The wallet info matching LIVE_CONFIG.walletId.
 * @throws Error if the configured wallet ID is not found.
 */
export async function resolveConfiguredWallet(): Promise<LiveWalletInfo> {
  const wallets = await fetchWallets();
  const wallet = wallets.find((w) => w.id === LIVE_CONFIG.walletId);
  if (!wallet) {
    throw new Error(
      `Wallet ID "${LIVE_CONFIG.walletId}" not found in your DBotX account. ` +
        `Available wallets: ${wallets.map((w) => `${w.id} (${w.address})`).join(", ")}`,
    );
  }
  return wallet;
}

/**
 * Fetch the native coin SOL balance for the configured wallet address.
 *
 * Endpoint: GET /kline/wallet/balance?chain=solana&walletAddress=...
 * Data endpoint: https://api-data-v1.dbotx.com
 *
 * Note: This endpoint costs 5 credits per call and is rate-limited to 6000/min
 * for data APIs — well within our polling budget.
 *
 * @returns The current SOL balance.
 */
export async function fetchBalance(): Promise<LiveBalance> {
  const url = `${LIVE_CONFIG.dataBaseUrl}/kline/wallet/balance` +
    `?chain=solana&walletAddress=${encodeURIComponent(LIVE_CONFIG.walletAddress)}`;

  const body = await getJson<LiveWalletBalanceResponse>(url);

  if (body.err) throw new Error("Balance API returned err: true");

  markBalanceUpdate();

  return {
    balanceSol: body.res.uiAmount,
  };
}

// ---------------------------------------------------------------------------
// Reactive balance stream
// ---------------------------------------------------------------------------

/** Subject to trigger a manual balance refresh from anywhere in the app. */
export const refreshBalance$ = new Subject<void>();

/** Latest cached balance snapshot (null before first fetch). */
export let latestBalance: LiveBalance | null = null;

/**
 * Update the synchronous balance snapshot.
 * Used internally and also exported for testability.
 * @param balance - The new balance value.
 */
export function setLatestBalance(balance: LiveBalance | null): void {
  latestBalance = balance;
}

/**
 * Manual refresh stream — emits on refreshBalance$.next().
 */
const manualRefresh$ = refreshBalance$.pipe(
  switchMap(() =>
    from(fetchBalance()).pipe(
      tap((b) => { latestBalance = b; }),
      catchError((err) => {
        console.error("[live/wallet] Balance fetch failed:", err);
        return EMPTY;
      }),
    ),
  ),
);

/**
 * Auto-polling stream with the configured interval.
 */
const polling$ = timer(
  LIVE_CONFIG.accountPollIntervalMs,
  LIVE_CONFIG.accountPollIntervalMs,
).pipe(
  switchMap(() =>
    from(fetchBalance()).pipe(
      tap((b) => { latestBalance = b; }),
      catchError((err) => {
        console.error("[live/wallet] Balance fetch failed:", err);
        return EMPTY;
      }),
    ),
  ),
);

/**
 * Merged balance stream: emits on manual refresh and auto-polling.
 */
export const walletBalance$ = merge(manualRefresh$, polling$).pipe(
  shareReplay({ bufferSize: 1, refCount: true }),
);
