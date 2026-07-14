import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let lastTelegramMessage: string | undefined;
let removedPosition: unknown;
let untrackedToken: string | undefined;

mock.module("../../telegram/telegram_bot", () => ({
  sendTelegram: (msg: string) => { lastTelegramMessage = msg; },
}));

mock.module("../../strategy/positions_store", () => ({
  removePosition: (...args: unknown[]) => { removedPosition = args; },
}));

mock.module("../../data_stream/price_engine", () => ({
  untrackToken: (token: string) => { untrackedToken = token; },
}));

import {
  handleTradeResult,
  type TradeResultNotification,
} from "./trade-ws";
import {
  initLiveStore,
  addOrder,
  addPosition,
  getStoreOrders,
  type StoredOrder,
} from "./store";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "trade-ws-handler-"));
  const dbPath = join(tmpDir, "test.json");
  initLiveStore(dbPath);
  lastTelegramMessage = undefined;
  removedPosition = undefined;
  untrackedToken = undefined;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const sampleOrder: StoredOrder = {
  id: "order1",
  type: "buy",
  pair: "pair1",
  token: "token1",
  tokenName: "TestToken",
  amountSol: 0.1,
  createdAt: Date.now(),
};

const sellNotif: TradeResultNotification = {
  id: "order1",
  state: "done",
  source: "swap_order",
  chain: "solana",
  type: "sell",
  token: "token1",
  pair: "pair1",
  symbol: "TKN",
};

const buyNotif: TradeResultNotification = {
  id: "order1",
  state: "done",
  source: "swap_order",
  chain: "solana",
  type: "buy",
  token: "token1",
  pair: "pair1",
  symbol: "TKN",
};

describe("handleTradeResult with matching order", () => {
  beforeEach(() => {
    addOrder(sampleOrder);
    addPosition({
      orderId: "order1",
      pair: "pair1",
      token: "token1",
      tokenName: "TestToken",
      entryPriceUsd: 1.0,
      sizeSol: 0.1,
      status: "open",
      openedAt: Date.now(),
    });
  });

  test("buy notification sends telegram message", () => {
    handleTradeResult(buyNotif);
    expect(lastTelegramMessage).toBeDefined();
    expect(lastTelegramMessage).toContain("TestToken");
  });

  test("sell done notification closes position and untracks token", () => {
    handleTradeResult(sellNotif);
    expect(untrackedToken).toBe("token1");
  });

  test("sell done notification sends telegram", () => {
    handleTradeResult(sellNotif);
    expect(lastTelegramMessage).toBeDefined();
    expect(lastTelegramMessage).toContain("Sell Success");
  });

  test("failed sell notification does not close position", () => {
    handleTradeResult({ ...sellNotif, state: "fail" });
    expect(untrackedToken).toBeUndefined();
  });
});

describe("handleTradeResult without matching order", () => {
  test("sell notification still sends telegram", () => {
    handleTradeResult(sellNotif);
    expect(lastTelegramMessage).toBeDefined();
  });

  test("buy notification without order does not send telegram", () => {
    handleTradeResult(buyNotif);
    expect(lastTelegramMessage).toBeUndefined();
  });
});
