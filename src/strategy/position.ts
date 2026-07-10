import { BehaviorSubject, Observable, Subject } from "rxjs";
import { CONFIG } from "../config";
import type { AveScannerSignal } from "../telegram/ave_scanner_parser";
import type {
  PerformanceReport,
  Position,
  PositionEvent,
  PumpEvent,
  SimAccount,
} from "../data_stream/types";
import type { TradingApi } from "./api";

let positionIdCounter = 0;
const positions = new Map<string, Position>();
const closedPositions: Position[] = [];

interface QueuedSignal {
  signal: AveScannerSignal;
  timestamp: number;
}

const signalQueue: QueuedSignal[] = [];

const openPositionsSubject = new BehaviorSubject<Position[]>([]);
const positionEventSubject = new Subject<PositionEvent>();
const positionClosedSubject = new Subject<PositionEvent>();
const signalQueueCountSubject = new BehaviorSubject<number>(0);

export const openPositions$: Observable<Position[]> =
  openPositionsSubject.asObservable();
export const positionEvent$: Observable<PositionEvent> =
  positionEventSubject.asObservable();
export const positionClosed$: Observable<PositionEvent> =
  positionClosedSubject.asObservable();
export const signalQueueCount$: Observable<number> =
  signalQueueCountSubject.asObservable();

let latestAccount: SimAccount = {
  balance: 1000,
  change24h: 0,
  changeAll: 0,
  holdTokens: 0,
};

/* -------------------------------------------------------------------------- */
/*  Mutex                                                                     */
/* -------------------------------------------------------------------------- */

let mutexQueue: Array<() => Promise<void>> = [];
let mutexBusy = false;

async function mutex<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    mutexQueue.push(async () => {
      try {
        resolve(await fn());
      } catch (e) {
        reject(e);
      }
    });
    if (!mutexBusy) drainMutex();
  });
}

async function drainMutex(): Promise<void> {
  mutexBusy = true;
  while (mutexQueue.length > 0) {
    const next = mutexQueue.shift()!;
    await next();
  }
  mutexBusy = false;
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function broadcastPositions(): void {
  openPositionsSubject.next(
    [...positions.values()].filter((p) => p.status === "open"),
  );
}

function broadcastQueueCount(): void {
  signalQueueCountSubject.next(signalQueue.length);
}

function generateId(): string {
  return `pos_${++positionIdCounter}_${Date.now()}`;
}

function hasSameAddress(
  a: AveScannerSignal,
  b: AveScannerSignal,
): boolean {
  if (a.LP && b.LP && a.LP === b.LP) return true;
  if (a.CA && b.CA && a.CA === b.CA) return true;
  return false;
}

/* -------------------------------------------------------------------------- */
/*  Signal Queue                                                              */
/* -------------------------------------------------------------------------- */

export function enqueueSignal(signal: AveScannerSignal): void {
  const now = Date.now();
  const ttlMs = CONFIG.signalQueueTtlSecs * 1000;

  const duplicateIdx = signalQueue.findIndex((q) =>
    hasSameAddress(q.signal, signal),
  );
  if (duplicateIdx !== -1) {
    signalQueue[duplicateIdx] = { signal, timestamp: now };
    console.log(
      `[Queue] Replaced duplicate ${signal.Token}, new TTL ${CONFIG.signalQueueTtlSecs}s`,
    );
    broadcastQueueCount();
    return;
  }

  const expiredIdx = signalQueue.findIndex(
    (q) => now - q.timestamp > ttlMs,
  );
  if (expiredIdx !== -1) {
    const removed = signalQueue.splice(expiredIdx, 1)[0];
    console.log(`[Queue] Dropped expired ${removed.signal.Token} for new ${signal.Token}`);
    signalQueue.push({ signal, timestamp: now });
    broadcastQueueCount();
    return;
  }

  if (signalQueue.length >= CONFIG.signalQueueSize) {
    console.log(
      `[Queue] Full (${CONFIG.signalQueueSize}), rejecting ${signal.Token}`,
    );
    return;
  }

  signalQueue.push({ signal, timestamp: now });
  broadcastQueueCount();
  console.log(
    `[Queue] Enqueued ${signal.Token} (${signalQueue.length}/${CONFIG.signalQueueSize})`,
  );
}

export function cleanupExpiredSignals(): void {
  const now = Date.now();
  const ttlMs = CONFIG.signalQueueTtlSecs * 1000;
  const before = signalQueue.length;

  for (let i = signalQueue.length - 1; i >= 0; i--) {
    if (now - signalQueue[i].timestamp > ttlMs) {
      const removed = signalQueue.splice(i, 1)[0];
      console.log(`[Queue] Expired signal ${removed.signal.Token}, removed`);
    }
  }

  if (signalQueue.length !== before) broadcastQueueCount();
}

export function getSignalQueueSize(): number {
  return signalQueue.length;
}

async function tryDequeue(api: TradingApi): Promise<void> {
  cleanupExpiredSignals();

  const open = [...positions.values()].filter((p) => p.status === "open");
  if (open.length >= CONFIG.maxPositions) return;
  if (signalQueue.length === 0) return;

  const next = signalQueue.shift()!;
  broadcastQueueCount();
  console.log(`[Queue] Processing queued signal: ${next.signal.Token}`);
  await openPosition(api, next.signal);
}

/* -------------------------------------------------------------------------- */
/*  Position Management                                                       */
/* -------------------------------------------------------------------------- */

export async function openPosition(
  api: TradingApi,
  signal: AveScannerSignal,
): Promise<Position | null> {
  return mutex(async () => {
    const pair = signal.LP;
    const tokenName = signal.Token ?? "Unknown";
    const tokenCA = signal.CA ?? "";

    if (!pair) {
      console.log(`[Position] No LP for ${tokenName}, skipping`);
      return null;
    }

    const open = [...positions.values()].filter((p) => p.status === "open");
    if (open.length >= CONFIG.maxPositions) {
      console.log(
        `[Position] Max positions (${CONFIG.maxPositions}) reached, enqueuing ${tokenName}`,
      );
      enqueueSignal(signal);
      return null;
    }

    if (positions.has(pair)) {
      console.log(`[Position] Already have position for ${pair}, skipping`);
      return null;
    }

    if (tokenCA) {
      const exists = [...positions.values()].some(
        (p) => p.token.toLowerCase() === tokenCA.toLowerCase(),
      );
      if (exists) {
        console.log(`[Position] Already tracking CA ${tokenCA}, skipping`);
        return null;
      }
    }

    console.log(
      `[Position] Buying ${tokenName} (${pair}) with ${CONFIG.positionSize} SOL`,
    );

    try {
      const result = await api.buy(
        pair,
        CONFIG.positionSize,
        tokenName,
        tokenCA,
      );

      const entryPrice = result.priceUsd ?? 0;
      if (!entryPrice || entryPrice <= 0) {
        console.error(
          `[Position] Invalid entry price (${entryPrice}) for ${tokenName}, aborting`,
        );
        return null;
      }

      const sizeToken = CONFIG.positionSize / entryPrice;

      const position: Position = {
        id: generateId(),
        orderId: result.id,
        pair,
        token: tokenCA,
        tokenName,
        entryPriceUsd: entryPrice,
        sizeSol: CONFIG.positionSize,
        sizeToken,
        openedAt: Date.now(),
        peakPriceUsd: entryPrice,
        currentPriceUsd: entryPrice,
        soldPct: 0,
        status: "open",
        lastUpdateAt: Date.now(),
        currentProfitPct: 0,
        partialTierIndex: 0,
      };

      positions.set(pair, position);
      broadcastPositions();

      positionEventSubject.next({ type: "opened", position });

      console.log(
        `[Position] Opened ${tokenName} @ ${fmtUsd(entryPrice)} | ${CONFIG.positionSize} SOL`,
      );

      return position;
    } catch (error) {
      console.error(`[Position] Failed to buy ${tokenName}:`, error);
      return null;
    }
  });
}

export async function closePosition(
  api: TradingApi,
  pair: string,
  reason: string,
): Promise<void> {
  return mutex(async () => {
    const pos = positions.get(pair);
    if (!pos || pos.status === "closed") return;

    console.log(`[Position] Closing ${pos.tokenName} (${reason})`);

    try {
      const remainingPct = 1 - pos.soldPct;
      if (remainingPct > 0.001) {
        const result = await api.sell(pair, remainingPct);
        if (result.priceUsd) pos.closePriceUsd = result.priceUsd;
      }

      pos.status = "closed";
      pos.closeReason = reason;
      pos.closedAt = Date.now();
      pos.lastUpdateAt = Date.now();
      pos.currentProfitPct =
        pos.entryPriceUsd > 0
          ? ((pos.closePriceUsd ?? pos.currentPriceUsd) -
              pos.entryPriceUsd) /
            pos.entryPriceUsd
          : 0;

      closedPositions.push({ ...pos });
      positions.delete(pair);
      broadcastPositions();

      positionEventSubject.next({ type: "closed", position: pos, reason });
      positionClosedSubject.next({ type: "closed", position: pos, reason });

      console.log(`[Position] Closed ${pos.tokenName} (${reason})`);

      await tryDequeue(api);
    } catch (error) {
      console.error(`[Position] Failed to sell ${pos.tokenName}:`, error);
    }
  });
}

export async function handlePriceUpdate(
  api: TradingApi,
  event: PumpEvent,
): Promise<void> {
  return mutex(async () => {
    const price = parseFloat(event.price);
    if (!Number.isFinite(price) || price <= 0) return;

    const mint = event.mint;

    for (const pos of positions.values()) {
      if (pos.status !== "open") continue;

      const match =
        pos.token.toLowerCase() === mint.toLowerCase() ||
        pos.pair.toLowerCase() === mint.toLowerCase();

      if (!match) continue;

      pos.currentPriceUsd = price;
      pos.lastUpdateAt = Date.now();

      if (price > pos.peakPriceUsd) {
        pos.peakPriceUsd = price;
      }

      pos.currentProfitPct =
        pos.entryPriceUsd > 0
          ? (price - pos.entryPriceUsd) / pos.entryPriceUsd
          : 0;

      const peakProfitPct =
        pos.entryPriceUsd > 0
          ? (pos.peakPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd
          : 0;

      await checkStopLoss(api, pos);
      await checkTrailingStop(api, pos, peakProfitPct);
      await checkTrailingTP(api, pos, peakProfitPct);
      await checkPartialTP(api, pos, price);
    }
  });
}

/* -------------------------------------------------------------------------- */
/*  TP / SL Logic                                                             */
/* -------------------------------------------------------------------------- */

async function checkStopLoss(
  api: TradingApi,
  pos: Position,
): Promise<void> {
  if (!CONFIG.stopLossPct) return;
  const slThreshold = -Math.abs(CONFIG.stopLossPct);
  if (pos.currentProfitPct <= slThreshold) {
    await closePosition(api, pos.pair, "stop_loss");
  }
}

async function checkTrailingStop(
  api: TradingApi,
  pos: Position,
  peakProfitPct: number,
): Promise<void> {
  if (
    CONFIG.trailingActivationPct <= 0 ||
    CONFIG.trailingDistancePct <= 0
  )
    return;
  if (peakProfitPct < CONFIG.trailingActivationPct) return;

  const drawdown = peakProfitPct - pos.currentProfitPct;
  if (drawdown >= CONFIG.trailingDistancePct) {
    await closePosition(api, pos.pair, "trailing_stop");
  }
}

async function checkTrailingTP(
  api: TradingApi,
  pos: Position,
  peakProfitPct: number,
): Promise<void> {
  if (CONFIG.trailingTpDistancePct <= 0) return;
  if (peakProfitPct < CONFIG.trailingTpDistancePct) return;

  const drawdown = peakProfitPct - pos.currentProfitPct;
  if (drawdown >= CONFIG.trailingTpDistancePct * 0.5) {
    await closePosition(api, pos.pair, "trailing_tp");
  }
}

async function checkPartialTP(
  api: TradingApi,
  pos: Position,
  currentPrice: number,
): Promise<void> {
  if (!CONFIG.partialTpEnabled) return;
  const tiers = CONFIG.partialTpTiers;
  if (tiers.length === 0) return;

  const profitPct =
    pos.entryPriceUsd > 0
      ? (currentPrice - pos.entryPriceUsd) / pos.entryPriceUsd
      : 0;

  while (pos.partialTierIndex < tiers.length) {
    const tier = tiers[pos.partialTierIndex];
    if (profitPct < tier.at) break;

    const remainingPct = 1 - pos.soldPct;
    if (remainingPct <= 0.001) {
      pos.partialTierIndex++;
      continue;
    }

    const tierTarget = tier.pct;
    const sellRatio = Math.min(tierTarget / remainingPct, 1);

    if (sellRatio <= 0.001) {
      pos.partialTierIndex++;
      continue;
    }

    console.log(
      `[Position] Partial TP: selling ${(sellRatio * 100).toFixed(0)}% of remaining ${pos.tokenName} at +${(profitPct * 100).toFixed(2)}%`,
    );

    try {
      const result = await api.sell(pos.pair, sellRatio);
      pos.soldPct += tierTarget;
      pos.partialTierIndex++;

      positionEventSubject.next({
        type: "partial_sold",
        position: pos,
        soldPct: tierTarget,
        profitPct: profitPct,
      });

      if (result.priceUsd) {
        console.log(
          `[Position] Partial sell ${pos.tokenName} at ${fmtUsd(result.priceUsd)}`,
        );
      }
    } catch (error) {
      console.error(`[Position] Partial TP sell failed:`, error);
      break;
    }
  }

  const totalSold = pos.soldPct;
  const backstopRemaining = 1 - totalSold;

  if (
    CONFIG.backstopTpPct > 0 &&
    backstopRemaining > 0.001 &&
    profitPct >= CONFIG.backstopTpPct
  ) {
    await closePosition(api, pos.pair, "take_profit");
  }
}

export async function checkExpiredPositions(api: TradingApi): Promise<void> {
  return mutex(async () => {
    const now = Date.now();

    for (const pos of [...positions.values()]) {
      if (pos.status !== "open") continue;

      const ageMs = now - pos.openedAt;
      const ageSecs = ageMs / 1000;

      if (ageSecs < CONFIG.baseTtlSecs) continue;

      const isProfitable =
        CONFIG.minProfitForTtlExtensionPct > 0 &&
        pos.currentProfitPct >= CONFIG.minProfitForTtlExtensionPct;

      if (isProfitable && ageSecs < CONFIG.maxTtlSecs) {
        continue;
      }

      await closePosition(api, pos.pair, "expired");
    }
  });
}

/* -------------------------------------------------------------------------- */
/*  Account Info                                                              */
/* -------------------------------------------------------------------------- */

export async function refreshAccountInfo(
  api: TradingApi,
): Promise<SimAccount> {
  try {
    latestAccount = await api.getAccountInfo();
    return latestAccount;
  } catch (error) {
    console.error("[Position] Failed to fetch account info:", error);
    return latestAccount;
  }
}

export function getAccountInfo(): SimAccount {
  return latestAccount;
}

export function getOpenPositions(): Position[] {
  return [...positions.values()].filter((p) => p.status === "open");
}

/* -------------------------------------------------------------------------- */
/*  Report                                                                    */
/* -------------------------------------------------------------------------- */

export function getReport(): PerformanceReport {
  const open = [...positions.values()].filter((p) => p.status === "open");
  const all = [...closedPositions];

  const winningTrades = all.filter(
    (p) => (p.currentProfitPct ?? 0) >= 0,
  ).length;
  const losingTrades = all.filter(
    (p) => (p.currentProfitPct ?? 0) < 0,
  ).length;
  const closedCount = all.length;
  const totalPositions = open.length + closedCount;

  const totalProfitPct = all.reduce(
    (sum, p) => sum + (p.currentProfitPct ?? 0),
    0,
  );

  const profits = all.map((p) => p.currentProfitPct ?? 0);
  const bestTradePct = profits.length > 0 ? Math.max(...profits) : 0;
  const worstTradePct = profits.length > 0 ? Math.min(...profits) : 0;
  const avgProfitPct =
    profits.length > 0
      ? profits.reduce((s, v) => s + v, 0) / profits.length
      : 0;

  const reasons: Record<string, number> = {};
  for (const p of all) {
    const r = p.closeReason ?? "unknown";
    reasons[r] = (reasons[r] ?? 0) + 1;
  }

  return {
    openPositions: open.length,
    closedPositions: closedCount,
    totalPositions,
    winningTrades,
    losingTrades,
    winRate: closedCount > 0 ? (winningTrades / closedCount) * 100 : 0,
    totalProfitPct,
    totalProfitUsd: 0,
    bestTradePct,
    worstTradePct,
    avgProfitPct,
    avgProfitUsd: 0,
    reasons,
  };
}

export function getBalanceStr(): string {
  const change24 = latestAccount.change24h;
  return [
    `💰 Balance: \`${latestAccount.balance.toFixed(2)} SOL\``,
    `📊 Change: \`${change24 >= 0 ? "+" : ""}${(change24 * 100).toFixed(2)}%\` (24h)`,
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/*  Utility                                                                   */
/* -------------------------------------------------------------------------- */

function fmtUsd(value: number): string {
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.001) return `$${value.toFixed(6)}`;
  return `$${value.toFixed(10)}`;
}
