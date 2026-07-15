import { BehaviorSubject } from "rxjs";

import { CONFIG } from "../../../config";
import type { TradingAccount } from "../../types";

// ============================================================================
// Types
// ============================================================================

/**
 * Represents the current paper trading account.
 *
 * The structure intentionally mirrors the live account as closely as possible
 * so both execution modes expose a consistent interface.
 */
export interface PaperAccount {
  /** Available SOL balance. */
  balance: number;

  /** Starting balance used for PnL calculations. */
  initialBalance: number;

  /** Total account value (balance + open positions). */
  equity: number;

  /** Closed profit/loss. */
  realizedPnl: number;

  /** Open profit/loss. */
  unrealizedPnl: number;

  /** Number of completed trades. */
  tradeCount: number;

  /** Last account update (Unix timestamp in milliseconds). */
  updatedAt: number;
}

// ============================================================================
// Initial State
// ============================================================================

/** Default paper wallet balance. */
const DEFAULT_BALANCE = CONFIG.pumpapiPaperWalletBalanceSol;

/**
 * Creates a new immutable account snapshot.
 */
function createAccount(balance: number): Readonly<PaperAccount> {
  return Object.freeze({
    balance,
    initialBalance: balance,
    equity: balance,
    realizedPnl: 0,
    unrealizedPnl: 0,
    tradeCount: 0,
    updatedAt: Date.now(),
  });
}

/**
 * Cached account state.
 *
 * This is the single source of truth for the paper wallet.
 */
let account = createAccount(DEFAULT_BALANCE);

// ============================================================================
// Reactive State
// ============================================================================

/**
 * Internal account subject.
 *
 * Only this module is allowed to publish updates.
 */
const accountSubject = new BehaviorSubject(account);

/**
 * Observable stream of paper account updates.
 */
export const paperAccount$ = accountSubject.asObservable();

// ============================================================================
// Validation
// ============================================================================

/**
 * Validates an account snapshot.
 */
function validateAccount(account: PaperAccount): void {
  if (!Number.isFinite(account.balance) || account.balance < 0) {
    throw new Error("Invalid paper account balance.");
  }

  if (!Number.isFinite(account.equity) || account.equity < 0) {
    throw new Error("Invalid paper account equity.");
  }

  if (account.tradeCount < 0) {
    throw new Error("Invalid paper account trade count.");
  }
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Applies a partial update to the current account.
 *
 * Only changed values are emitted to subscribers.
 */
function updateAccount(patch: Partial<PaperAccount>): void {
  const next: PaperAccount = {
    ...account,
    ...patch,
    updatedAt: Date.now(),
  };

  validateAccount(next);

  if (
    next.balance === account.balance &&
    next.equity === account.equity &&
    next.realizedPnl === account.realizedPnl &&
    next.unrealizedPnl === account.unrealizedPnl &&
    next.tradeCount === account.tradeCount
  ) {
    return;
  }

  account = Object.freeze(next);

  accountSubject.next(account);
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Initializes the paper trading account.
 *
 * Any previous account state is discarded and all statistics are reset.
 * This is typically called once during application startup or before
 * beginning a new simulation/backtest.
 */
export function initPaperAccount(startBalance: number = DEFAULT_BALANCE): void {
  if (!Number.isFinite(startBalance) || startBalance < 0) {
    throw new Error("Invalid initial paper account balance.");
  }

  account = createAccount(startBalance);

  accountSubject.next(account);
}

/**
 * Applies a partial update to the paper account.
 *
 * This is the primary function that should be used by the paper trading
 * engine after a simulated trade.
 *
 * Example:
 *
 * updatePaperAccount({
 *   balance: 4.82,
 *   equity: 5.13,
 *   realizedPnl: 0.28,
 *   tradeCount: 12,
 * });
 */
export function updatePaperAccount(patch: Partial<PaperAccount>): void {
  updateAccount(patch);
}

/**
 * Updates only the available SOL balance.
 *
 * Convenience wrapper around updatePaperAccount().
 */
export function updatePaperBalance(balance: number): void {
  updateAccount({ balance, equity: balance });
}

/**
 * Resets the paper wallet back to its configured default balance.
 */
export function resetPaperAccount(): void {
  account = createAccount(DEFAULT_BALANCE);

  accountSubject.next(account);
}

/**
 * Returns the latest cached account snapshot.
 *
 * A shallow copy is returned to prevent callers from accidentally
 * mutating the internal account.
 */
export function getPaperAccount(): PaperAccount {
  return {
    ...account,
  };
}

/**
 * Returns the current available SOL balance.
 */
export function getPaperBalance(): number {
  return account.balance;
}

/**
 * Returns true once the paper account has been initialized.
 */
export function hasPaperAccount(): boolean {
  return account.updatedAt > 0;
}

/**
 * Converts a PaperAccount into the generic TradingAccount model
 * used throughout the trading engine.
 */
export function toTradingAccount(account: PaperAccount): TradingAccount {
  const changeAll =
    account.initialBalance > 0
      ? (account.equity - account.initialBalance) / account.initialBalance
      : 0;

  return {
    balance: account.balance,
    currency: "SOL" as const,

    // change24h: 0,
    changeAll,

    // Updated by the paper position engine.
    // holdTokens: 0,
  };
}
