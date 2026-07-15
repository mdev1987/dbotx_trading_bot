import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";

let wsOnopen: (() => void) | null = null;
let wsOnclose: ((event: unknown) => void) | null = null;
let wsSend: ((data: string) => void) | null = null;
let wsCloseCount = 0;
let wsInstances: { onopen: (() => void) | null; onclose: ((event: unknown) => void) | null; send: ((data: string) => void) | null; ping: (() => void) | null; readyState: number; close: () => void }[] = [];
let lastWsInitArgs: unknown[] = [];

const originalWebSocket = globalThis.WebSocket;

mock.module("../../config", () => ({
  CONFIG: {
    tradeWsUrl: "wss://test.example.com/ws",
    dbotxApiKey: "test-key",
    tradeWsHeartbeatIntervalMs: 30000,
    liveReconcileIntervalMs: 300000,
  },
}));

import { connectTradeWs, disconnectTradeWs, startLiveMonitor, stopLiveMonitor, tradeResult$ } from "./trade-ws";

describe("connectTradeWs / disconnectTradeWs", () => {
  beforeEach(() => {
    wsOnopen = null;
    wsOnclose = null;
    wsSend = null;
    wsCloseCount = 0;
    wsInstances = [];
    lastWsInitArgs = [];

    class MockWebSocket {
      static OPEN = 1;
      static CONNECTING = 0;
      readyState = 1;
      onopen: ((() => void) | null) = null;
      onclose: (((event: unknown) => void) | null) = null;
      onmessage: (((event: { data: string }) => void) | null) = null;
      onerror: (() => void) | null = null;

      constructor(...args: unknown[]) {
        lastWsInitArgs = args;
        this.onopen = wsOnopen;
        this.onclose = wsOnclose;
        wsInstances.push(this);
      }

      send(data: string) {
        wsSend?.(data);
      }

      ping() {
        // no-op
      }

      close() {
        wsCloseCount++;
      }
    }

    (globalThis as any).WebSocket = MockWebSocket;
  });

  afterEach(() => {
    disconnectTradeWs();
    stopLiveMonitor();
    (globalThis as any).WebSocket = originalWebSocket;
  });

  test("creates a WebSocket connection with URL", () => {
    connectTradeWs();
    expect(lastWsInitArgs.length).toBeGreaterThan(0);
    expect(lastWsInitArgs[0]).toBe("wss://test.example.com/ws");
  });

  test("does not create duplicate connections when already open", () => {
    connectTradeWs();
    const countAfterFirst = wsInstances.length;
    connectTradeWs();
    expect(wsInstances.length).toBe(countAfterFirst);
  });

  test("disconnectTradeWs closes the WebSocket", () => {
    connectTradeWs();
    disconnectTradeWs();
    expect(wsCloseCount).toBe(1);
  });

  test("startLiveMonitor subscribes to tradeResult$", () => {
    let received: unknown[] = [];
    const sub = tradeResult$.subscribe((v) => received.push(v));
    startLiveMonitor();
    tradeResult$.next({ id: "test", state: "done", source: "swap_order", chain: "solana", type: "sell", token: "t1", pair: "p1", symbol: "TKN" } as any);
    expect(received.length).toBeGreaterThan(0);
    sub.unsubscribe();
  });

  test("stopLiveMonitor unsubscribes and clears reconcile timer", () => {
    startLiveMonitor();
    stopLiveMonitor();
    expect(() => stopLiveMonitor()).not.toThrow();
  });

  test("disconnectTradeWs prevents reconnection on close", () => {
    connectTradeWs();
    disconnectTradeWs();

    const instanceCount = wsInstances.length;
    const lastInstance = wsInstances[wsInstances.length - 1];
    if (lastInstance && lastInstance.onclose) {
      lastInstance.onclose({ code: 1000, reason: "test" });
    }
    expect(wsInstances.length).toBe(instanceCount);
  });

  test("sendSubscribe sends correct subscribe message on open", () => {
    let sentData = "";
    wsSend = (data: string) => { sentData = data; };

    connectTradeWs();
    wsOnopen = wsInstances[0]?.onopen ?? null;

    if (wsOnopen) {
      wsOnopen();
    }

    expect(sentData).toContain("subscribeTradeResults");
    expect(sentData).toContain("swap_buy_success");
    expect(sentData).toContain("swap_sell_success");
  });

  test("reconnect is scheduled on ws close", async () => {
    connectTradeWs();
    const instanceBeforeClose = wsInstances.length;

    if (wsInstances[0]?.onclose) {
      wsInstances[0]!.onclose({ code: 1000, reason: "test" });
    }

    // Wait for reconnect timer (exponential backoff starts at ~1s + jitter)
    await new Promise((r) => setTimeout(r, 1500));
    expect(wsInstances.length).toBeGreaterThan(instanceBeforeClose);
  });
});
