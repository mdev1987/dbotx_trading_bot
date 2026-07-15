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

  try {
    ws = new WebSocket(CONFIG.wsUrl, {
      headers: { "x-api-key": CONFIG.dbotxApiKey },
    });
  } catch (err) {
    console.error("[DBotX Data] Connection failed:", err);
    scheduleReconnect();
    return;
  }

  ws.addEventListener("open", onOpen);
  ws.addEventListener("message", onMessage);
  ws.addEventListener("close", onClose);
  ws.addEventListener("error", onError);
}

function startHeartbeat(): void {
  stopHeartbeat();
  heartbeat = setInterval(() => {
    try {
      ws?.ping();
    } catch (err) {
      console.warn("[DBotX Data] Heartbeat ping failed:", err);
    }
  }, CONFIG.wsHeartbeatIntervalMs);
}

function stopHeartbeat(): void {
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
}

function onOpen(): void {
  console.log("[DBotX Data] Connected");

  reconnectDelay = CONFIG.wsDataInitialReconnectDelayMs;

  if (activePairs.size > 0) ws!.send(buildSubscribePacket());

  startHeartbeat();
}

function onClose(event: CloseEvent): void {
  console.log("[DBotX Data] Disconnected — code:", event.code, "reason:", event.reason);

  stopHeartbeat();

  if (reconnect) return;

  scheduleReconnect();
}

function scheduleReconnect(): void {
  const delay = Math.min(reconnectDelay, CONFIG.wsDataMaxReconnectDelayMs);
  const jitter = delay * 0.2 * Math.random();
  reconnectDelay = Math.min(reconnectDelay * 2, CONFIG.wsDataMaxReconnectDelayMs);

  reconnect = setTimeout(() => {
    reconnect = null;
    connectDataWs();
  }, delay + jitter);
}

function onError(error: Event): void {
  console.error("[DBotX Data] Error:", error);
}

function onMessage(event: MessageEvent): void {
  const raw = event.data.toString();

  let packet: DbotxWsPacket;

  try {
    packet = JSON.parse(raw) as DbotxWsPacket;
  } catch (err) {
    console.warn("[DBotX Data] Failed to parse message:", err);
    return;
  }

  if (packet.status === "ack") return;

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
  stopHeartbeat();
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
