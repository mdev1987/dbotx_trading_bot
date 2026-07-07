import { Subject, BehaviorSubject } from "rxjs";

// Relay subjects — events flow through after initBridge() wires them up
export const positionEvent$ = new Subject<any>();
export const positionClosed$ = new Subject<any>();
export const openPositions$ = new BehaviorSubject<any[]>([]);

// Mode-adaptive report & display functions (assigned during initBridge)
let _reportFn: () => any = () => ({
  totalPositions: 0, closedPositions: 0, openPositions: 0,
  winningTrades: 0, losingTrades: 0, winRate: 0,
  totalProfitUsd: 0, totalProfitPct: 0,
  avgProfitPct: 0, avgProfitUsd: 0,
  bestTradePct: 0, worstTradePct: 0,
  reasons: {} as Record<string, number>,
});
let _balanceStrFn: () => string = () => "";

export function getReport(): any { return _reportFn(); }
export function getBalanceStr(): string { return _balanceStrFn(); }

export interface BridgeConfig {
  positionEvent$: any;
  positionClosed$: any;
  openPositions$: any;
  getReport: () => any;
  getBalanceStr: () => string;
}

export function initBridge(config: BridgeConfig): void {
  config.positionEvent$.subscribe((e: any) => positionEvent$.next(e));
  config.positionClosed$.subscribe((e: any) => {
    if (e && e.type === undefined && e.id !== undefined) {
      positionClosed$.next({ type: "closed", position: e, closeReason: e.closeReason });
    } else {
      positionClosed$.next(e);
    }
  });
  config.openPositions$.subscribe((positions: any[]) => openPositions$.next(positions));
  _reportFn = config.getReport;
  _balanceStrFn = config.getBalanceStr;
}
