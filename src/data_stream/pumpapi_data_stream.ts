import { Subject } from "rxjs";
import type { PumpEvent } from "./types";

const WS_URL = "wss://stream.pumpapi.io/";
const HEARTBEAT_MS = 30_000;

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let activeMint: string | null = null;

export const pumpEvent$ = new Subject<PumpEvent>();

export function connectPumpStream(tokenMint?: string): void {
  if (tokenMint) activeMint = tokenMint;
  if (
    ws?.readyState === WebSocket.OPEN ||
    ws?.readyState === WebSocket.CONNECTING
  )
    return;
  ws?.close();

  console.log("[PumpAPI] Connecting...");

  ws = new WebSocket(WS_URL);

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
    }, HEARTBEAT_MS);
  };

  ws.onmessage = ({ data }) => {
    try {
      const raw = JSON.parse(data as string);

      if (raw?.type === "pong") return;

      const event = raw as Record<string, unknown>;
      if (activeMint && event.mint !== activeMint) return;
      if (event.action !== "buy" && event.action !== "sell") return;

      const pumpEvent: PumpEvent = {
        mint: event.mint as string,
        action: event.action as "buy" | "sell",
        price: String(event.price ?? ""),
        timestamp: Date.now(),
      };

      pumpEvent$.next(pumpEvent);

      console.log(
        `[PumpAPI] ${pumpEvent.action.toUpperCase()} | mint:${pumpEvent.mint.slice(0, 8)} | price:${pumpEvent.price}`,
      );
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
      }, 1000);
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
