import { Subject } from "rxjs";

import { CONFIG } from "../config";
import type { PriceUpdate } from "./types";

const HEARTBEAT_MS = 30_000;
const MAX_RECONNECT_MS = 30_000;

interface Tx {
  p: string;
  tt: "buy" | "sell";
  s: number;
  u: number;
  q: number;
  t: number;
  tx: string;
}

interface PairState {
  pair: string;
  priceUsd: number;
  priceSol: number;
  previousPriceUsd: number;
  previousPriceSol: number;
  lastSide: "buy" | "sell";
  lastTradeUsd: number;
  lastTradeSol: number;
  lastTokenAmount: number;
  lastTradeTime: number;
  tx: string;
}

const states = new Map<string, PairState>();

let ws: WebSocket | null = null;

let heartbeat: Timer | null = null;
let reconnect: Timer | null = null;

let reconnectDelay = 1000;

const activePairs = new Set<string>();

export const priceUpdate$ = new Subject<PriceUpdate>();

function buildSubscribePacket() {
  return JSON.stringify({
    method: "subscribe",
    type: "tx",
    args: { pair: [...activePairs] },
  });
}

export function subscribePairs(pairs: string[]): void {
  for (const pair of pairs) activePairs.add(pair);
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(buildSubscribePacket());
  }
}

export function unsubscribePair(pair: string): void {
  activePairs.delete(pair);
}

export function connectDataWs(): void {
  if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;
  ws?.close();

  console.log("[DBotX Data] Connecting...");

  ws = new WebSocket(CONFIG.wsUrl, {
    headers: { "x-api-key": CONFIG.dbotxApiKey },
  });

  ws.addEventListener("open", onOpen);
  ws.addEventListener("message", onMessage);
  ws.addEventListener("close", onClose);
  ws.addEventListener("error", onError);
}

function onOpen() {
  console.log("[DBotX Data] Connected");

  reconnectDelay = 1000;

  if (activePairs.size > 0) ws!.send(buildSubscribePacket());

  if (heartbeat) clearInterval(heartbeat);

  heartbeat = setInterval(() => {
    ws?.ping();
  }, HEARTBEAT_MS);
}

function onClose() {
  console.log("[DBotX Data] Disconnected");

  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }

  if (reconnect) return;

  reconnect = setTimeout(() => {
    reconnect = null;

    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_MS);

    connectDataWs();
  }, reconnectDelay);
}

function onError(error: Event) {
  console.error("[DBotX Data]", error);
}

function onMessage(event: MessageEvent) {
  const raw = event.data.toString();

  if (raw.includes('"status":"ack"')) return;

  let packet: any;

  try {
    packet = JSON.parse(raw);
  } catch {
    return;
  }

  if (packet.type !== "tx") return;

  const trades: Tx[] = packet.result;

  if (!Array.isArray(trades)) return;

  for (const trade of trades) {
    processTrade(trade);
  }
}

export function disconnectDataWs(): void {
  if (reconnect) {
    clearTimeout(reconnect);
    reconnect = null;
  }
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
  ws?.close();
  ws = null;
}

function processTrade(trade: Tx) {
  if (!trade.q) return;

  const inv = 1 / trade.q;

  const priceUsd = trade.u * inv;
  const priceSol = trade.s * inv;

  let state = states.get(trade.p);

  if (!state) {
    state = {
      pair: trade.p,

      priceUsd,
      priceSol,

      previousPriceUsd: priceUsd,
      previousPriceSol: priceSol,

      lastSide: trade.tt,

      lastTradeUsd: trade.u,
      lastTradeSol: trade.s,

      lastTokenAmount: trade.q,

      lastTradeTime: trade.t,

      tx: trade.tx,
    };

    states.set(trade.p, state);

    print(state, true);

    priceUpdate$.next({
      pair: trade.p,
      token: "",
      priceUsd,
      timestamp: trade.t * 1000,
    });

    return;
  }

  state.previousPriceUsd = state.priceUsd;
  state.previousPriceSol = state.priceSol;

  state.priceUsd = priceUsd;
  state.priceSol = priceSol;

  state.lastSide = trade.tt;

  state.lastTradeUsd = trade.u;
  state.lastTradeSol = trade.s;

  state.lastTokenAmount = trade.q;

  state.lastTradeTime = trade.t;

  state.tx = trade.tx;

  print(state, false);

  priceUpdate$.next({
    pair: trade.p,
    token: "",
    priceUsd,
    timestamp: trade.t * 1000,
  });
}

function print(state: PairState, first: boolean) {
  const pct =
    state.previousPriceUsd === 0
      ? 0
      : ((state.priceUsd - state.previousPriceUsd) / state.previousPriceUsd) *
        100;

  const arrow = first ? "•" : pct > 0 ? "▲" : pct < 0 ? "▼" : "=";

  console.log(
    [
      new Date(state.lastTradeTime * 1000).toLocaleTimeString(),

      arrow,

      state.lastSide.toUpperCase().padEnd(4),

      state.pair.slice(0, 8),

      `$${state.priceUsd.toFixed(10)}`,

      `${pct >= 0 ? "+" : ""}${pct.toFixed(4)}%`,

      `Vol:$${state.lastTradeUsd.toFixed(2)}`,

      `${state.lastTokenAmount.toFixed(2)} tokens`,
    ].join(" | "),
  );
}
