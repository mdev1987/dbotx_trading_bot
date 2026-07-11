import { Subject } from "rxjs";

import { CONFIG } from "../config";
import { PriceSource, type PumpEvent, type PumpWsPacket } from "./types";

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
const activeMints = new Set<string>();

export const pumpApiPriceUpdateEvent$ = new Subject<PumpEvent>();

export function subscribeMint(mint: string): void {
  activeMints.add(mint);
}

export function unsubscribeMint(mint: string): void {
  activeMints.delete(mint);
}

export function connectPumpStream(): void {
  if (
    ws?.readyState === WebSocket.OPEN ||
    ws?.readyState === WebSocket.CONNECTING
  )
    return;
  ws?.close();

  console.log("[PumpAPI] Connecting...");

  ws = new WebSocket(CONFIG.pumpapiWsUrl);

  ws.onopen = () => {
    console.log("[PumpAPI] Connected");
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      try {
        ws?.send(JSON.stringify({ type: "ping" }));
      } catch {
        // ignore
      }
    }, CONFIG.wsHeartbeatIntervalMs);
  };

  ws.onmessage = ({ data }) => {
    try {
      const raw = JSON.parse(data as string) as PumpWsPacket;
      if (raw?.type === "pong") return;

      if (activeMints.size > 0 && (!raw.mint || !activeMints.has(raw.mint))) {
        return;
      }
      if (raw.action !== "buy" && raw.action !== "sell") {
        return;
      }

      const pumpEvent: PumpEvent = {
        mint: raw.mint ?? "",
        action: raw.action as "buy" | "sell",
        price: String(raw.price ?? ""),
        quoteMint: raw.quoteMint ?? "",
        source: PriceSource.PUMPAPI,
        timestamp: Date.now(),
      };

      pumpApiPriceUpdateEvent$.next(pumpEvent);
    } catch {
      // skip
    }
  };

  ws.onerror = (error) => {
    console.error("[PumpAPI]", error);
  };

  ws.onclose = () => {
    console.log("[PumpAPI] Disconnected");
    ws = null;

    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectPumpStream();
      }, CONFIG.wsReconnectDelayMs);
    }
  };
}

export function disconnectPumpStream(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  ws?.close();
  ws = null;
}
