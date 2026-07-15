import { BehaviorSubject } from "rxjs";
import type { TradingAccount } from "../../types";

export interface PaperAccount {
  balance: number;
  initialBalance: number;
}

let paperAccount: PaperAccount = {
  balance: 2,
  initialBalance: 2,
};

export const paperAccount$ = new BehaviorSubject<PaperAccount>(paperAccount);

export function initPaperAccount(startBalanceSol: number): void {
  paperAccount = { balance: startBalanceSol, initialBalance: startBalanceSol };
  paperAccount$.next(paperAccount);
}

export function getPaperAccount(): PaperAccount {
  return paperAccount;
}

export function updatePaperBalance(newBalance: number): void {
  paperAccount = { ...paperAccount, balance: newBalance };
  paperAccount$.next(paperAccount);
}

export function resetPaperAccount(): void {
  paperAccount = { balance: paperAccount.initialBalance, initialBalance: paperAccount.initialBalance };
  paperAccount$.next(paperAccount);
}

export function toTradingAccount(account: PaperAccount): TradingAccount {
  const changeTotal = account.initialBalance > 0
    ? (account.balance - account.initialBalance) / account.initialBalance
    : 0;

  return {
    balance: account.balance,
    currency: "SOL",
    change24h: 0,
    changeAll: changeTotal,
    holdTokens: 0,
  };
}
