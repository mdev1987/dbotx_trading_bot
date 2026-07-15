import { BehaviorSubject } from "rxjs";

import { CONFIG } from "../../../config";
import { pumpapiHttp } from "../../http";
import type { TradingAccount } from "../../types";

// ============================================================================
// Types
// ============================================================================

/**
 * Represents the current PumpAPI trading account.
 *
 * Only the native SOL balance is tracked here. Token balances can be
 * added later if the trading engine needs them.
 */
export interface PumpAccount {
  /** Current SOL balance. */
  balance: number;
  /** Unix timestamp (ms) of the last successful refresh. */
  updatedAt: number;
}

/**
 * Response returned by the PumpAPI `getBalances` action.
 *
 * Only the fields used by this module are included.
 */
interface PumpBalancesResponse {
  solBalance?: number;
  err?: string;
}

/**
 * Internal mutable account state.
 *
 * Consumers should never mutate this object directly.
 */
let account: Readonly<PumpAccount> = Object.freeze({
  balance: 0,
  updatedAt: 0,
});

// ============================================================================
// Reactive State
// ============================================================================

/**
 * Internal BehaviorSubject.
 *
 * Kept private so this module is the only place allowed to emit updates.
 */
const accountSubject = new BehaviorSubject(account);

/**
 * Observable stream of account updates.
 *
 * Subscribers receive the latest balance immediately upon subscription.
 */
export const pumpAccount$ = accountSubject.asObservable();

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Ensures the PumpAPI response is valid.
 *
 * Throws an Error if the API reports a failure or the response is malformed.
 */
function validateResponse(
  response: PumpBalancesResponse,
): asserts response is Required<Pick<PumpBalancesResponse, "solBalance">> {
  if (response.err) {
    throw new Error(response.err);
  }

  if (typeof response.solBalance !== "number") {
    throw new Error("PumpAPI returned an invalid SOL balance.");
  }
}

/**
 * Creates an immutable account snapshot.
 */
function createAccount(balance: number): Readonly<PumpAccount> {
  return Object.freeze({
    balance,
    updatedAt: Date.now(),
  });
}

/**
 * Updates the cached account and notifies subscribers.
 *
 * Duplicate emissions are automatically ignored.
 */
function updateAccount(balance: number): void {
  if (account.balance === balance) {
    return;
  }

  account = createAccount(balance);

  accountSubject.next(account);
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Fetches the latest account balance from PumpAPI.
 *
 * On success:
 *  - Validates the API response.
 *  - Updates the local cache.
 *  - Notifies subscribers if the balance changed.
 *
 * On failure:
 *  - Logs the error.
 *  - Returns the last known account state.
 */
export async function refreshPumpBalance(): Promise<PumpAccount> {
  try {
    const response = await pumpapiHttp.post<PumpBalancesResponse>("", {
      action: "getBalances",
      privateKey: CONFIG.pumpapiPrivateKey,
    });

    validateResponse(response);

    updateAccount(response.solBalance);
  } catch (error) {
    console.error("[PumpAccount] Failed to refresh balance:", error);
  }

  return getPumpAccount();
}

/**
 * Alias kept for backwards compatibility.
 */
export const fetchPumpBalance = refreshPumpBalance;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Converts the PumpAPI account model into the application's
 * generic TradingAccount interface.
 */
export function toTradingAccount(account: PumpAccount): TradingAccount {
  return {
    balance: account.balance,
    currency: "SOL" as const,
    changeAll: 0,
  };
}

/**
 * Returns the latest cached account snapshot.
 *
 * A shallow copy is returned so callers cannot accidentally
 * mutate the internal cached state.
 */
export function getPumpAccount(): PumpAccount {
  return {
    ...account,
  };
}

/**
 * Returns the current SOL balance.
 *
 * Convenience helper for callers that only need the balance.
 */
export function getPumpBalance(): number {
  return account.balance;
}

/**
 * Returns true when the account has been successfully loaded
 * at least once from PumpAPI.
 */
export function hasPumpAccount(): boolean {
  return account.updatedAt > 0;
}
