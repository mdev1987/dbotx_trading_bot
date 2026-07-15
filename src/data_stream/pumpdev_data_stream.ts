import { Subject } from "rxjs";

import { CONFIG } from "../config";
import { PriceSource, type PumpDevEvent } from "./types";

// ============================================================================
// Public Events
// ============================================================================

export const pumpDevEvent$ = new Subject<PumpDevEvent>();

export type PumpDevConnectionState = "disconnected" | "connecting" | "connected";
export const pumpDevConnectionState$ = new Subject<PumpDevConnectionState>();

// ============================================================================
// Internal State
// ============================================================================

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1_000;
const MAX_RECONNECT_DELAY = 30_000;

const trackedMints = new Set<string>();
let subscribedNewToken = false;

// ============================================================================
// Public API
// ============================================================================

export function subscribeTokenTrade(mint: string): void {
  trackedMints.add(mint);
  sendSubscribe();
}

export function unsubscribeTokenTrade(mint: string): void {
  trackedMints.delete(mint);
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ method: "unsubscribeTokenTrade", keys: [mint] }));
  }
}

export function subscribeNewToken(): void {
  subscribedNewToken = true;
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ method: "subscribeNewToken" }));
  }
}

export function unsubscribeNewToken(): void {
  subscribedNewToken = false;
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ method: "unsubscribeNewToken" }));
  }
}

// ============================================================================
// Connection
// ============================================================================

export function connectPumpDev(): void {
  if (
    ws?.readyState === WebSocket.OPEN ||
    ws?.readyState === WebSocket.CONNECTING
  )
    return;
  ws?.close();

  pumpDevConnectionState$.next("connecting");
  console.log("[PumpDev] Connecting...");

  ws = new WebSocket("wss://pumpdev.io/ws");

  ws.onopen = () => {
    console.log("[PumpDev] Connected");
    pumpDevConnectionState$.next("connected");
    reconnectDelay = 1_000;

    sendSubscribe();
  };

  ws.onmessage = ({ data }) => {
    let packet: Record<string, unknown>;
    try {
      packet = JSON.parse(data as string);
    } catch {
      console.warn("[PumpDev] Failed to parse message");
      return;
    }

    const type = packet.type as string | undefined;
    if (type === "connected" || type === "subscribed") {
      console.log(`[PumpDev] ${packet.message ?? type}`);
      return;
    }

    const event = toPumpDevEvent(packet);
    if (event) {
      pumpDevEvent$.next(event);
    }
  };

  ws.onerror = (error) => {
    console.error("[PumpDev]", error);
  };

  ws.onclose = () => {
    console.log("[PumpDev] Disconnected");
    pumpDevConnectionState$.next("disconnected");
    ws = null;

    scheduleReconnect();
  };
}

export function disconnectPumpDev(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (subscribedNewToken && ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ method: "unsubscribeNewToken" }));
  }
  if (trackedMints.size > 0 && ws?.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({ method: "unsubscribeTokenTrade", keys: [...trackedMints] }),
    );
  }
  trackedMints.clear();
  subscribedNewToken = false;
  ws?.close();
  ws = null;
}

// ============================================================================
// Internal Helpers
// ============================================================================

function sendSubscribe(): void {
  if (ws?.readyState !== WebSocket.OPEN) return;

  if (trackedMints.size > 0) {
    ws.send(
      JSON.stringify({ method: "subscribeTokenTrade", keys: [...trackedMints] }),
    );
  }
  if (subscribedNewToken) {
    ws.send(JSON.stringify({ method: "subscribeNewToken" }));
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = Math.min(reconnectDelay, MAX_RECONNECT_DELAY);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectPumpDev();
  }, delay);
}

function toPumpDevEvent(packet: Record<string, unknown>): PumpDevEvent | null {
  const txType = packet.txType as string | undefined;
  if (!txType || !["buy", "sell", "create", "complete", "create_pool"].includes(txType)) {
    return null;
  }

  const mint = packet.mint as string | undefined;
  if (!mint) return null;

  const vTokens = Number(packet.vTokensInBondingCurve ?? 0);
  const vQuote = Number(packet.vQuoteInBondingCurve ?? 0);
  const poolBase = Number(packet.poolBaseReserves ?? 0);
  const poolQuote = Number(packet.poolQuoteReserves ?? 0);

  let priceSol = 0;
  if (vTokens > 0 && vQuote > 0) {
    priceSol = vQuote / vTokens;
  } else if (poolBase > 0 && poolQuote > 0) {
    priceSol = poolQuote / poolBase;
  }

  const source = packet.source as string | undefined;
  const quoteMint = (packet.quoteMint as string) ?? "";

  return {
    mint,
    txType: txType as PumpDevEvent["txType"],
    quoteMint,
    quoteAmount: (packet.quoteAmount as number | null) ?? null,
    solAmount: (packet.solAmount as number | null) ?? null,
    tokenAmount: Number(packet.tokenAmount ?? 0),
    marketCapQuote: (packet.marketCapQuote as number | null) ?? null,
    marketCapSol: (packet.marketCapSol as number | null) ?? null,
    traderPublicKey: (packet.traderPublicKey as string) ?? "",
    signature: (packet.signature as string) ?? "",
    source,
    pool: packet.pool as string | undefined,
    bondingCurveKey: packet.bondingCurveKey as string | undefined,
    vTokensInBondingCurve: packet.vTokensInBondingCurve as number | undefined,
    vQuoteInBondingCurve: packet.vQuoteInBondingCurve as number | undefined,
    vSolInBondingCurve: packet.vSolInBondingCurve as number | undefined,
    poolBaseReserves: packet.poolBaseReserves as number | undefined,
    poolBaseReservesUi: packet.poolBaseReservesUi as number | undefined,
    poolQuoteReserves: packet.poolQuoteReserves as number | undefined,
    poolQuoteReservesUi: packet.poolQuoteReservesUi as number | null | undefined,
    priceSol,
    priceUsd: priceSol,
    timestamp: Date.now(),
  };
}
