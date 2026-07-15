import { BehaviorSubject } from "rxjs";
import { CONFIG } from "../../../config";
import { simHttp as http } from "../../http";

export interface SimulatorAccount {
  balance: number;
  currency: "SOL" | "USD";
  change24h: number;
  changeAll: number;
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

let simulatorAccount: SimulatorAccount = {
  balance: 0,
  currency: "USD",
  change24h: 0,
  changeAll: 0,
  holdTokens: 0,
};

export const simulatorAccount$ = new BehaviorSubject<SimulatorAccount>(
  simulatorAccount,
);

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
      currency: "USD",
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

export function getSimulatorAccount(): SimulatorAccount {
  return simulatorAccount;
}

export function resetSimulatorAccount(): void {
  simulatorAccount = {
    balance: 0,
    currency: "USD",
    change24h: 0,
    changeAll: 0,
    holdTokens: 0,
  };

  simulatorAccount$.next(simulatorAccount);
}
