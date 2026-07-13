import { Subject } from "rxjs";

import { CONFIG } from "../config";
import { PriceSource, type DbotxEvent, type DbotxTrade, type DbotxWsPacket } from "./types";

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

let heartbeat: ReturnType<typeof setInterval> | null = null;
let reconnect: ReturnType<typeof setTimeout> | null = null;

let reconnectDelay = CONFIG.wsDataInitialReconnectDelayMs;

const activePairs = new Set<string>();

export const dbotxPriceUpdateEvent$ = new Subject<DbotxEvent>();

function buildSubscribePacket(): string {
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

function buildUnsubscribePacket(pair: string): string {
  return JSON.stringify({
    method: "unsubscribe",
    type: "tx",
    args: { pair: [pair] },
  });
}

export function unsubscribePair(pair: string): void {
  activePairs.delete(pair);
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(buildUnsubscribePacket(pair));
  }
}

export function connectDataWs(): void {
  if (
    ws?.readyState === WebSocket.OPEN ||
    ws?.readyState === WebSocket.CONNECTING
  )
    return;
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

function onOpen(): void {
  console.log("[DBotX Data] Connected");

  reconnectDelay = CONFIG.wsDataInitialReconnectDelayMs;

  if (activePairs.size > 0) ws!.send(buildSubscribePacket());

  if (heartbeat) clearInterval(heartbeat);

  heartbeat = setInterval(() => {
    ws?.ping();
  }, CONFIG.wsHeartbeatIntervalMs);
}

function onClose(): void {
  console.log("[DBotX Data] Disconnected");

  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }

  if (reconnect) return;

  reconnect = setTimeout(() => {
    reconnect = null;

    reconnectDelay = Math.min(reconnectDelay * 2, CONFIG.wsDataMaxReconnectDelayMs);

    connectDataWs();
  }, reconnectDelay);
}

function onError(error: Event): void {
  console.error("[DBotX Data]", error);
}

function onMessage(event: MessageEvent): void {
  const raw = event.data.toString();

  if (raw.includes('"status":"ack"')) return;

  let packet: DbotxWsPacket;

  try {
    packet = JSON.parse(raw) as DbotxWsPacket;
  } catch (err) {
    console.warn("[DBotX Data] Failed to parse message:", err);
    return;
  }

  if (packet.type !== "tx") return;

  const trades = packet.result;

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

function processTrade(trade: DbotxTrade): void {
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

    dbotxPriceUpdateEvent$.next({
      pair: trade.p,
      token: "",
      priceUsd,
      priceSol,
      source: PriceSource.DBOTX,
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

  dbotxPriceUpdateEvent$.next({
    pair: trade.p,
    token: "",
    priceUsd,
    priceSol,
    source: PriceSource.DBOTX,
    timestamp: trade.t * 1000,
  });
}
