import { BehaviorSubject } from "rxjs";

import { CONFIG } from "../../config";
import { http } from "./simulator_http";

/* -------------------------------------------------------------------------- */
/*                                   Types                                    */
/* -------------------------------------------------------------------------- */

/**
 * Current simulator account state.
 */
export interface SimulatorAccount {
  /** Current simulator balance (USD). */
  balance: number;

  /** 24-hour account performance. */
  change24h: number;

  /** Overall account performance. */
  changeAll: number;

  /** Number of currently held tokens. */
  holdTokens: number;
}

interface SimulatorAccountResponse {
  err: boolean;

  res: {
    balance: string;
    change24h: number;
    changeAll: number;
    holdTokens: number;
  };
}

/* -------------------------------------------------------------------------- */
/*                               Account State                                */
/* -------------------------------------------------------------------------- */

/**
 * Latest simulator account snapshot.
 *
 * Updated whenever refreshSimulatorAccount() succeeds.
 */
let simulatorAccount: SimulatorAccount = {
  balance: 0,
  change24h: 0,
  changeAll: 0,
  holdTokens: 0,
};

/**
 * Emits the latest simulator account.
 *
 * New subscribers immediately receive the newest snapshot.
 */
export const simulatorAccount$ = new BehaviorSubject<SimulatorAccount>(
  simulatorAccount,
);

/* -------------------------------------------------------------------------- */
/*                              Refresh Account                               */
/* -------------------------------------------------------------------------- */

/**
 * Downloads the latest simulator account information.
 *
 * Returns the cached value if the request fails.
 */
export async function refreshSimulatorAccount(): Promise<SimulatorAccount> {
  try {
    const response = await http.get<SimulatorAccountResponse>(
      "/simulator/sim_account",
    );

    if (response.err) {
      throw new Error("Simulator returned an error.");
    }

    simulatorAccount = {
      balance: Number(response.res.balance),
      change24h: response.res.change24h,
      changeAll: response.res.changeAll,
      holdTokens: response.res.holdTokens,
    };

    simulatorAccount$.next(simulatorAccount);
  } catch (error) {
    console.error("[Simulator] Failed to refresh account:", error);
  }

  return simulatorAccount;
}

/* -------------------------------------------------------------------------- */
/*                                   Getter                                   */
/* -------------------------------------------------------------------------- */

/**
 * Returns the latest cached simulator account.
 */
export function getSimulatorAccount(): SimulatorAccount {
  return simulatorAccount;
}

/* -------------------------------------------------------------------------- */
/*                                    Reset                                   */
/* -------------------------------------------------------------------------- */

/**
 * Clears cached simulator account information.
 *
 * Mainly used by tests and shutdown.
 */
export function resetSimulatorAccount(): void {
  simulatorAccount = {
    balance: 0,
    change24h: 0,
    changeAll: 0,
    holdTokens: 0,
  };

  simulatorAccount$.next(simulatorAccount);
}
