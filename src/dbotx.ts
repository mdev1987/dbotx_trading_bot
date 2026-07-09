import { Subject, BehaviorSubject, from, timer, Observable, EMPTY } from "rxjs";
import { filter, share, tap, concatMap, withLatestFrom, shareReplay, map, switchMap, catchError } from "rxjs/operators";

import { CONFIG } from "./config";
import type { PriceUpdate, ParsedSignal } from "./types";

const API_HEADERS = { "x-api-key": CONFIG.dbotxApiKey };

// ── Helpers ────────────────────────────────────────────────────────────────

function url(path: string, params?: Record<string, string | number>): string {
  const u = new URL(path.startsWith("http") ? path : `${CONFIG.baseUrl}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
    }
  }
  return u.toString();
}

async function apiGet<T>(baseUrl: string, path: string, params?: Record<string, string | number>): Promise<T> {
  const res = await fetch(url(`${baseUrl}${path}`, params), { headers: API_HEADERS });
  const json = await res.json() as { err: boolean; res: T };
  if (json.err) throw new Error(`API error: ${path}`);
  return json.res;
}

async function apiPost<T>(fullUrl: string, body: unknown): Promise<T> {
  const res = await fetch(fullUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...API_HEADERS },
    body: JSON.stringify(body),
  });
  const json = await res.json() as { err: boolean; res: T };
  if (json.err) throw new Error(`API error: POST ${fullUrl}`);
  return json.res;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Data WebSocket (price feed) ────────────────────────────────────────────

const dataWsRaw$ = new Subject<unknown>();
const dataWsConnected$ = new BehaviorSubject(false);

let _dataWs: WebSocket | null = null;
let _dataWsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let _activePairs = new Map<string, string | undefined>();

function connectDataWs(): void {
  if (_dataWs?.readyState === WebSocket.OPEN || _dataWs?.readyState === WebSocket.CONNECTING) return;
  _dataWs?.close();

  const ws = new WebSocket(CONFIG.wsUrl, { headers: { "x-api-key": CONFIG.dbotxApiKey } });

  ws.onopen = () => {
    _dataWs = ws;
    dataWsConnected$.next(true);
    if (_dataWsReconnectTimer) { clearTimeout(_dataWsReconnectTimer); _dataWsReconnectTimer = null; }
    console.log("[DBotX] Data WS connected");
    if (_activePairs.size > 0) syncPairs();
  };

  ws.onmessage = (e) => {
    if (typeof e.data !== "string") return;
    try { dataWsRaw$.next(JSON.parse(e.data)); } catch { /* skip invalid */ }
  };

  ws.onerror = () => { /* onclose will fire */ };

  ws.onclose = () => {
    _dataWs = null;
    dataWsConnected$.next(false);
    scheduleDataWsReconnect();
  };
}

function scheduleDataWsReconnect(): void {
  if (_dataWsReconnectTimer) return;
  _dataWsReconnectTimer = setTimeout(() => {
    _dataWsReconnectTimer = null;
    connectDataWs();
  }, CONFIG.wsReconnectDelayMs);
}

function syncPairs(): boolean {
  if (!_dataWs || _dataWs.readyState !== WebSocket.OPEN) return false;
  const entries: Array<{ pair: string; token?: string }> = [];
  for (const [pair, token] of _activePairs) entries.push({ pair, token: token ?? undefined });
  if (entries.length === 0) return false;
  _dataWs.send(JSON.stringify({ method: "subscribe", type: "pairsInfo", args: { pairs: entries } }));
  return true;
}

// Heartbeat ping
dataWsConnected$.pipe(filter(Boolean), switchMap(() => timer(CONFIG.wsHeartbeatIntervalMs, CONFIG.wsHeartbeatIntervalMs))).subscribe(() => {
  try { _dataWs?.ping(); } catch { /* ignore */ }
});

connectDataWs();

dataWsConnected$.pipe(filter(Boolean)).subscribe(() => console.log("[DBotX] Data WS connected"));
dataWsConnected$.pipe(filter((v) => !v)).subscribe(() => console.log("[DBotX] Data WS disconnected"));

// ── Price Update Stream ────────────────────────────────────────────────────

export const priceUpdate$ = new Subject<PriceUpdate>();

// Parse WS messages into price updates
dataWsRaw$.pipe(
  tap((msg) => {
    const m = msg as Record<string, unknown>;
    if (m.status === "ack") return;
    console.log(`[DBotX] WS data: ${JSON.stringify(m).slice(0, 300)}`);
  }),
  concatMap((msg) => {
    const updates: PriceUpdate[] = [];
    const m = msg as Record<string, unknown>;
    if (Array.isArray(m.result)) {
      for (const item of m.result) {
        const pair = String(item.p ?? "");
        if (!pair) continue;
        const rawPrice = item.tpu ?? item.tp;
        const priceUsd = typeof rawPrice === "number" ? rawPrice : Number(rawPrice);
        if (!Number.isFinite(priceUsd) || priceUsd <= 0) continue;
        updates.push({ pair, token: _activePairs.get(pair) ?? "", priceUsd, timestamp: Date.now() });
      }
    } else if (m.result != null && typeof m.result === "object") {
      const r = m.result as Record<string, unknown>;
      const pair = String(m.pair ?? r.pair ?? "");
      if (!pair) return from(updates);
      const rawPrice = m.priceUsd ?? r.priceUsd ?? r.tpu ?? r.tp;
      const priceUsd = typeof rawPrice === "number" ? rawPrice : Number(rawPrice);
      if (!Number.isFinite(priceUsd) || priceUsd <= 0) return from(updates);
      updates.push({ pair, token: _activePairs.get(pair) ?? "", priceUsd, timestamp: Date.now() });
    }
    return from(updates);
  }),
).subscribe((u) => priceUpdate$.next(u));

export function pushPriceUpdate(update: PriceUpdate): void {
  priceUpdate$.next(update);
}

export function subscribePairs(pairs: Array<{ pair: string; token?: string }>): void {
  for (const { pair, token } of pairs) _activePairs.set(pair, token);
  syncPairs();
}

export function unsubscribePair(pair: string): void {
  _activePairs.delete(pair);
}

// ── Trade Results WebSocket (LIVE mode only) ───────────────────────────────

export const tradeResultEvent$ = new Subject<unknown>();
export const buySuccessEvent$ = tradeResultEvent$.pipe(
  filter((e: any) => e.result?.state === "done" && e.result?.type === "buy" && e.result?.source === "swap_order"),
  share(),
);
export const sellSuccessEvent$ = tradeResultEvent$.pipe(
  filter((e: any) => e.result?.state === "done" && e.result?.type === "sell" && e.result?.source === "swap_order" && e.result?.subSource === null),
  share(),
);
export const tpSuccessEvent$ = tradeResultEvent$.pipe(
  filter((e: any) => e.result?.state === "done" && e.result?.subSource === "swap_take_profit"),
  share(),
);
export const slSuccessEvent$ = tradeResultEvent$.pipe(
  filter((e: any) => e.result?.state === "done" && e.result?.subSource === "swap_stop_loss"),
  share(),
);
export const trailingSuccessEvent$ = tradeResultEvent$.pipe(
  filter((e: any) => e.result?.state === "done" && e.result?.subSource === "swap_trailing_stop"),
  share(),
);
export const tradeFailEvent$ = tradeResultEvent$.pipe(
  filter((e: any) => e.result?.state === "fail" || e.result?.state === "expired"),
  share(),
);

let _tradeWs: WebSocket | null = null;
let _tradeWsReconnectTimer: ReturnType<typeof setTimeout> | null = null;

function connectTradeWs(): void {
  if (_tradeWs?.readyState === WebSocket.OPEN || _tradeWs?.readyState === WebSocket.CONNECTING) return;
  _tradeWs?.close();

  const ws = new WebSocket(CONFIG.tradeWsUrl, { headers: { "x-api-key": CONFIG.dbotxApiKey } });

  ws.onopen = () => {
    _tradeWs = ws;
    if (_tradeWsReconnectTimer) { clearTimeout(_tradeWsReconnectTimer); _tradeWsReconnectTimer = null; }
    console.log("[DBotX] Trade WS connected");
  };

  ws.onmessage = (e) => {
    if (typeof e.data !== "string") return;
    try {
      const msg = JSON.parse(e.data);
      if ((msg as any)?.method === "tradeResultNotify") tradeResultEvent$.next(msg);
    } catch { /* skip */ }
  };

  ws.onerror = () => {};

  ws.onclose = () => {
    _tradeWs = null;
    if (_tradeWsReconnectTimer) return;
    _tradeWsReconnectTimer = setTimeout(() => {
      _tradeWsReconnectTimer = null;
      if (CONFIG.liveMode) connectTradeWs();
    }, CONFIG.wsReconnectDelayMs);
  };
}

export function connectTradeResultsWs(): void {
  if (CONFIG.liveMode) connectTradeWs();
}

export function disconnectTradeResultsWs(): void {
  if (_tradeWsReconnectTimer) { clearTimeout(_tradeWsReconnectTimer); _tradeWsReconnectTimer = null; }
  _tradeWs?.close();
  _tradeWs = null;
}

// ── REST: Simulator API ────────────────────────────────────────────────────

interface SimSwapRequest {
  chain: string;
  pair: string;
  type: "buy" | "sell";
  amountOrPercent: number;
  walletId?: string;
  priorityFee?: number | "";
  slippage?: number;
}

export async function simBuy(pair: string, amountSol: number): Promise<string> {
  const body: SimSwapRequest = {
    chain: "solana", pair, type: "buy", amountOrPercent: amountSol,
    walletId: "", priorityFee: "", slippage: CONFIG.defaultSlippage,
  };
  const res = await apiPost<{ id: string }>(`${CONFIG.baseUrl}/simulator/sim_swap_order`, body);
  return res.id;
}

export async function simSell(pair: string, amountOrPercent = 1): Promise<string> {
  const body: SimSwapRequest = {
    chain: "solana", pair, type: "sell", amountOrPercent,
    walletId: "", priorityFee: "", slippage: CONFIG.defaultSlippage,
  };
  const res = await apiPost<{ id: string }>(`${CONFIG.baseUrl}/simulator/sim_swap_order`, body);
  return res.id;
}

export interface TradePair {
  _id: string;
  tokenInfo0: { contract: string; name: string; symbol: string };
  tokenInfo1: { symbol: string };
  token0Balance: string;
  costUsd: number;
  buyTokenAmount: string;
  sellTokenAmount: string;
  sellReceiveUsd: number;
  sellProfitPercent: number | null;
  fullProfitPercent: number;
  fullProfitUsd: number;
}

export async function fetchTradePairs(balanceGt0: boolean): Promise<TradePair[]> {
  return apiGet<TradePair[]>(CONFIG.servapiBaseUrl, "/simulator/trade_pairs", {
    page: 0, size: 20, chain: "solana", balanceGt0: balanceGt0 ? "true" : "false",
  });
}

export interface SimTradeRecord {
  id: string;
  priceUsd: number;
  totalUsd: number;
}

export async function fetchBuyTrade(orderId: string): Promise<SimTradeRecord | null> {
  try {
    const trades = await apiGet<SimTradeRecord[]>(CONFIG.baseUrl, "/simulator/trades", {});
    return trades.find((t) => t.id === orderId) ?? null;
  } catch { return null; }
}

export interface PnLTask {
  sourceGroupIdx: number;
  state: string;
  triggerPriceUsd: number;
  basePriceUsd: number;
  currencyAmountUI: number;
  triggerPercent: number;
  triggerDirection: string;
}

export async function fetchPnLTasks(sourceId: string): Promise<PnLTask[]> {
  return apiGet<PnLTask[]>(CONFIG.servapiBaseUrl, "/simulator/pnl_orders_from_swap_order", {
    sourceId, page: 0, size: 20, sort: "-1",
  });
}

export interface SimulatorAccount {
  balance: number;
  change24h: number;
  changeAll: number;
  holdTokens: number;
}

export async function fetchSimAccount(): Promise<SimulatorAccount> {
  const r = await apiGet<{ balance: string; change24h: number; changeAll: number; holdTokens: number }>(
    CONFIG.baseUrl, "/simulator/sim_account",
  );
  return { balance: parseFloat(r.balance), change24h: r.change24h, changeAll: r.changeAll, holdTokens: r.holdTokens };
}

// ── REST: Live API ─────────────────────────────────────────────────────────

export interface LiveSwapOrderParams {
  chain: string;
  pair: string;
  walletId: string;
  type: "buy" | "sell";
  amountOrPercent: number;
  customFeeAndTip: boolean;
  priorityFee: string;
  gasFeeDelta: number;
  maxFeePerGas: number;
  jitoEnabled: boolean;
  jitoTip: number;
  maxSlippage: number;
  concurrentNodes: number;
  retries: number;
  migrateSellPercent?: number;
  minDevSellPercent?: number;
  devSellPercent?: number;
  stopEarnPercent?: number;
  stopLossPercent?: number;
  stopEarnGroup?: Array<{ pricePercent: number; amountPercent: number }>;
  stopLossGroup?: Array<{ pricePercent: number; amountPercent: number }>;
  trailingStopGroup?: Array<{ pricePercent: number; amountPercent: number; activePricePercent: number }>;
  pnlOrderExpireDelta: number;
  pnlOrderExpireExecute: boolean;
  pnlOrderUseMidPrice: boolean;
  pnlCustomConfigEnabled: boolean;
  pnlCustomConfig?: Record<string, unknown>;
}

function buildLiveBuyParams(pair: string, amountSol: number, signal?: ParsedSignal): LiveSwapOrderParams {
  const partialTpEnabled = CONFIG.partialTpEnabled;
  const partialTpTiers = CONFIG.partialTpTiers;
  const backstopTpPct = CONFIG.backstopTpPct;

  const stopEarnGroup: Array<{ pricePercent: number; amountPercent: number }> = [];
  if (partialTpEnabled) {
    for (const tier of partialTpTiers) stopEarnGroup.push({ pricePercent: tier.at, amountPercent: tier.pct });
    const maxPumpX = (signal as any)?.maxPumpX;
    const effectiveBackstop = maxPumpX && maxPumpX > 0 ? (maxPumpX - 1) * 0.7 : backstopTpPct;
    if (effectiveBackstop > 0) {
      const soldSoFar = partialTpTiers.reduce((s, t) => s + t.pct, 0);
      const remaining = 1 - soldSoFar;
      if (remaining > 0.001) stopEarnGroup.push({ pricePercent: effectiveBackstop, amountPercent: remaining });
    }
  } else if (backstopTpPct > 0) {
    stopEarnGroup.push({ pricePercent: backstopTpPct, amountPercent: 1 });
  }

  const trailingStopGroup = CONFIG.trailingDistancePct > 0
    ? [{ pricePercent: CONFIG.trailingDistancePct, amountPercent: 1, activePricePercent: CONFIG.trailingActivationPct }]
    : undefined;

  const expireDelta = Math.min(CONFIG.pnlOrderExpireDeltaMs, CONFIG.baseTtlSecs * 1000);

  return {
    chain: "solana", pair, walletId: CONFIG.walletId, type: "buy", amountOrPercent: amountSol,
    customFeeAndTip: CONFIG.customFeeAndTip, priorityFee: CONFIG.priorityFee,
    gasFeeDelta: 5, maxFeePerGas: 100, jitoEnabled: CONFIG.jitoEnabled, jitoTip: CONFIG.jitoTip,
    maxSlippage: CONFIG.maxSlippage, concurrentNodes: CONFIG.concurrentNodes, retries: CONFIG.retries,
    migrateSellPercent: CONFIG.migrateSellPercent,
    minDevSellPercent: CONFIG.minDevSellPercent, devSellPercent: CONFIG.devSellPercent,
    stopEarnGroup: stopEarnGroup.length > 0 ? stopEarnGroup : undefined,
    stopLossPercent: CONFIG.stopLossPct,
    trailingStopGroup,
    pnlOrderExpireDelta: expireDelta, pnlOrderExpireExecute: CONFIG.pnlOrderExpireExecute,
    pnlOrderUseMidPrice: CONFIG.pnlOrderUseMidPrice,
    pnlCustomConfigEnabled: true,
    pnlCustomConfig: {
      customFeeAndTip: CONFIG.customFeeAndTip, priorityFee: CONFIG.priorityFee,
      gasFeeDelta: 5, maxFeePerGas: 100, jitoEnabled: CONFIG.jitoEnabled, jitoTip: CONFIG.jitoTip,
      maxSlippage: CONFIG.maxSlippage, concurrentNodes: CONFIG.concurrentNodes, retries: CONFIG.retries,
    },
  };
}

export async function liveBuy(pair: string, amountSol: number, signal?: ParsedSignal): Promise<string> {
  const params = buildLiveBuyParams(pair, amountSol, signal);
  const res = await apiPost<{ id: string }>(`${CONFIG.baseUrl}/automation/swap_order`, params);
  return res.id;
}

export async function liveSell(pair: string): Promise<string> {
  const params: LiveSwapOrderParams = {
    chain: "solana", pair, walletId: CONFIG.walletId, type: "sell", amountOrPercent: 1,
    customFeeAndTip: CONFIG.customFeeAndTip, priorityFee: CONFIG.priorityFee,
    gasFeeDelta: 5, maxFeePerGas: 100, jitoEnabled: CONFIG.jitoEnabled, jitoTip: CONFIG.jitoTip,
    maxSlippage: CONFIG.maxSlippage, concurrentNodes: CONFIG.concurrentNodes, retries: CONFIG.retries,
    pnlOrderExpireDelta: 60_000, pnlOrderExpireExecute: true, pnlOrderUseMidPrice: false,
    pnlCustomConfigEnabled: false,
  };
  const res = await apiPost<{ id: string }>(`${CONFIG.baseUrl}/automation/swap_order`, params);
  return res.id;
}

export async function querySwapOrder(orderId: string): Promise<{ state: string; txPriceUsd?: number } | null> {
  try {
    const orders = await apiGet<Array<{ id: string; state: string; txPriceUsd?: number }>>(
      CONFIG.baseUrl, `/automation/swap_orders?ids=${encodeURIComponent(orderId)}`,
    );
    return orders[0] ?? null;
  } catch { return null; }
}

export async function pollOrderUntilDone(orderId: string, maxAttempts = CONFIG.maxSwapOrderPollAttempts, intervalMs = CONFIG.swapOrderPollMs): Promise<{ state: string; txPriceUsd?: number }> {
  for (let i = 0; i < maxAttempts; i++) {
    const order = await querySwapOrder(orderId);
    if (!order) { await sleep(intervalMs); continue; }
    if (order.state === "done") return order;
    if (order.state === "fail" || order.state === "expired") throw new Error(`Order ${orderId} ${order.state}`);
    await sleep(intervalMs);
  }
  throw new Error(`Order ${orderId} did not complete within ${maxAttempts} polls`);
}

// ── REST: Price polling fallback ───────────────────────────────────────────

export function startRestPricePolling(openPositions$: Observable<Array<{ pair: string; token: string; status: string; tokenName: string }>>): void {
  timer(0, CONFIG.tradePairPollMs).pipe(
    withLatestFrom(openPositions$),
    concatMap(async ([, positions]) => {
      const open = positions.filter((p) => p.status === "open");
      if (open.length === 0) return;
      for (const pos of open) {
        try {
          const body = await apiGet<{ id: string; tokenPrice?: number; rate?: number }>(
            CONFIG.dataBaseUrl, `/kline/pair_info?chain=solana&pair=${encodeURIComponent(pos.pair)}`,
          );
          if (!body.tokenPrice || !body.rate) continue;
          const priceUsd = body.tokenPrice * body.rate;
          if (priceUsd <= 0) continue;
          pushPriceUpdate({ pair: pos.pair, token: pos.token, priceUsd, timestamp: Date.now() });
        } catch { /* skip */ }
      }
    }),
  ).subscribe();
}

// ── REST: Simulator trade pair polling ─────────────────────────────────────

export function startSimPairPoll(openPositions$: Observable<Array<{ status: string; token: string; pair: string }>>, cb: (pair: TradePair) => void): void {
  timer(CONFIG.tradePairPollMs, CONFIG.tradePairPollMs).pipe(
    withLatestFrom(openPositions$),
    filter(([, open]) => open.some((p) => p.status === "open")),
    concatMap(async () => { try { return await fetchTradePairs(true); } catch { return []; } }),
    filter((pairs) => pairs.length > 0),
  ).subscribe((pairs) => {
    for (const pair of pairs) cb(pair);
  });
}

// ── REST: Simulator PnL task polling ───────────────────────────────────────

export function startSimPnLPoll(orderIds$: Observable<string[]>, cb: (orderId: string, tasks: PnLTask[]) => void): void {
  timer(CONFIG.pnlTaskPollMs, CONFIG.pnlTaskPollMs).pipe(
    withLatestFrom(orderIds$),
    filter(([, ids]) => ids.length > 0),
    concatMap(async ([, ids]) => {
      for (const id of ids) {
        try { cb(id, await fetchPnLTasks(id)); } catch { /* skip */ }
      }
    }),
  ).subscribe();
}

// ── Account stream (simulator) ─────────────────────────────────────────────

export const refreshAccount$ = new Subject<void>();

export const simAccount$ = refreshAccount$.pipe(
  switchMap(() => from(fetchSimAccount().then((a) => { latestSimAccount = a; return a; }))),
  catchError(() => EMPTY),
  shareReplay(1),
);

export let latestSimAccount: SimulatorAccount | null = null;

// Start auto-polling for sim account
if (!CONFIG.liveMode) {
  timer(CONFIG.accountPollIntervalMs, CONFIG.accountPollIntervalMs).pipe(
    switchMap(() => from(fetchSimAccount().then((a) => { latestSimAccount = a; return a; }))),
    catchError(() => EMPTY),
  ).subscribe();
}
