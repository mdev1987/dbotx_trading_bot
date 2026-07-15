import { describe, expect, test, mock, beforeEach } from "bun:test";
import * as recoveryModule from "./recovery";

let configMock: Record<string, unknown> = {
  walletAddress: "test_wallet",
  recoveryFetchPageSize: 20,
};

let httpGetMock: (path: string) => unknown;
let storeOrdersMock: unknown[] = [];
let storeOpenPositionsMock: unknown[] = [];
let storeAddPositionMock: unknown[] = [];
let addPositionResult: unknown[] | null = null;
let trackTokenCalls: unknown[][] = [];
let solPriceMock = 200;

mock.module("../../config", () => ({
  CONFIG: configMock,
}));

mock.module("../http", () => ({
  botHttp: {
    get: async (path: string) => httpGetMock(path),
  },
}));

mock.module("./store", () => ({
  getStoreOrders: () => storeOrdersMock,
  getStoreOpenPositions: () => storeOpenPositionsMock,
  addPosition: (...args: unknown[]) => { storeAddPositionMock.push(args); },
}));

mock.module("../../strategy/positions_store", () => ({
  addPosition: (...args: unknown[]) => {
    addPositionResult = args;
    return { token: args[0], pair: args[1], tokenName: args[2], entryPriceUsd: args[3], sizeSol: args[4] };
  },
}));

mock.module("../../data_stream/price_engine", () => ({
  trackToken: (...args: unknown[]) => { trackTokenCalls.push(args); },
  getSolPriceUsd: () => solPriceMock,
}));

import { recoverLivePositions, __TEST_DELAY_OVERRIDE } from "./recovery";

// Override delays to be instant for tests
const originalDelay = __TEST_DELAY_OVERRIDE.fn;
__TEST_DELAY_OVERRIDE.fn = () => Promise.resolve();

describe("recoverLivePositions", () => {
  beforeEach(() => {
    configMock = { walletAddress: "test_wallet", recoveryFetchPageSize: 20 };
    storeOrdersMock = [];
    storeOpenPositionsMock = [];
    storeAddPositionMock = [];
    addPositionResult = null;
    trackTokenCalls = [];
    solPriceMock = 200;
    httpGetMock = () => ({ err: true });
  });

  test("restores from store open positions (fast path)", async () => {
    storeOpenPositionsMock = [
      { token: "token1", pair: "pair1", tokenName: "Token1", entryPriceUsd: 1.0, sizeSol: 0.1 },
    ];

    await recoverLivePositions();

    expect(addPositionResult).not.toBeNull();
    expect(trackTokenCalls).toHaveLength(1);
    expect(trackTokenCalls[0]).toEqual(["token1", "pair1"]);
  });

  test("skips API recovery when no wallet address", async () => {
    configMock = { walletAddress: "", recoveryFetchPageSize: 20 };

    await recoverLivePositions();

    expect(addPositionResult).toBeNull();
  });

  test("falls back to API recovery when store is empty", async () => {
    httpGetMock = (path: string) => {
      if (path.includes("swap_trades")) {
        return {
          err: false,
          res: [
            {
              id: "trade1",
              type: "buy",
              state: "done",
              pair: "pair1",
              send: { amount: "100000000", info: { contract: "sol", decimals: 9, symbol: "SOL" } },
              receive: { amount: "1000000", info: { contract: "token1", decimals: 6, name: "Token1", symbol: "TKN" } },
              createAt: Date.now(),
            },
          ],
        };
      }
      if (path.includes("pnl_orders_from_swap_order")) {
        return { err: false, res: [] };
      }
      return { err: true };
    };

    await recoverLivePositions();

    expect(addPositionResult).not.toBeNull();
    if (addPositionResult) {
      expect(addPositionResult[0]).toBe("token1");
      expect(addPositionResult[1]).toBe("pair1");
    }
  });

  test("skips trades without entry price when solPrice is 0", async () => {
    solPriceMock = 0;
    httpGetMock = () => ({
      err: false,
      res: [
        {
          id: "trade1",
          type: "buy",
          state: "done",
          pair: "pair1",
          send: { amount: "100000000", info: { contract: "sol", decimals: 9, symbol: "SOL" } },
          receive: { amount: "1000000", info: { contract: "token1", decimals: 6, name: "Token1", symbol: "TKN" } },
          createAt: Date.now(),
        },
      ],
    });

    await recoverLivePositions();

    expect(addPositionResult).toBeNull();
  });

  test("skips trades when exit tasks already finished", async () => {
    httpGetMock = (path: string) => {
      if (path.includes("swap_trades")) {
        return {
          err: false,
          res: [
            {
              id: "trade1",
              type: "buy",
              state: "done",
              pair: "pair1",
              send: { amount: "100000000", info: { contract: "sol", decimals: 9, symbol: "SOL" } },
              receive: { amount: "1000000", info: { contract: "token1", decimals: 6, name: "Token1", symbol: "TKN" } },
              createAt: Date.now(),
            },
          ],
        };
      }
      if (path.includes("pnl_orders_from_swap_order")) {
        return {
          err: false,
          res: [{ id: "exit1", state: "done", tradeType: "sell", pair: "pair1", basePriceUsd: 0, sourceId: "trade1" }],
        };
      }
      return { err: true };
    };

    await recoverLivePositions();

    expect(addPositionResult).toBeNull();
  });

  test("uses basePriceUsd from active exit tasks for entry price", async () => {
    httpGetMock = (path: string) => {
      if (path.includes("swap_trades")) {
        return {
          err: false,
          res: [
            {
              id: "trade1",
              type: "buy",
              state: "done",
              pair: "pair1",
              send: { amount: "100000000", info: { contract: "sol", decimals: 9, symbol: "SOL" } },
              receive: { amount: "1000000", info: { contract: "token1", decimals: 6, name: "Token1", symbol: "TKN" } },
              createAt: Date.now(),
            },
          ],
        };
      }
      if (path.includes("pnl_orders_from_swap_order")) {
        return {
          err: false,
          res: [{ id: "exit1", state: "init", tradeType: "sell", pair: "pair1", basePriceUsd: 1.5, sourceId: "trade1" }],
        };
      }
      return { err: true };
    };

    await recoverLivePositions();

    expect(addPositionResult).not.toBeNull();
    if (addPositionResult) {
      expect(addPositionResult[3]).toBe(1.5);
    }
  });

  test("respects MAX_RECOVERY_PAGES pagination cap", async () => {
    let swapTradePageCount = 0;
    httpGetMock = (path: string) => {
      if (path.includes("swap_trades")) {
        swapTradePageCount++;
        return {
          err: false,
          res: Array(20).fill(null).map((_, i) => ({
            id: `trade_${swapTradePageCount}_${i}`,
            type: "buy",
            state: "done",
            pair: `pair_${swapTradePageCount}_${i}`,
            send: { amount: "100000000", info: { contract: "sol", decimals: 9, symbol: "SOL" } },
            receive: { amount: "1000000", info: { contract: `token${swapTradePageCount}`, decimals: 6, name: "Token", symbol: "TKN" } },
            createAt: Date.now(),
          })),
        };
      }
      if (path.includes("pnl_orders")) {
        return { err: false, res: [] };
      }
      return { err: true };
    };

    await recoverLivePositions();

    expect(swapTradePageCount).toBeLessThanOrEqual(10);
  });

  test("handles partial API failures gracefully", async () => {
    let callCount = 0;
    httpGetMock = () => {
      callCount++;
      if (callCount === 2) throw new Error("Network error");
      return {
        err: false,
        res: [
          {
            id: "trade1",
            type: "buy",
            state: "done",
            pair: "pair1",
            send: { amount: "100000000", info: { contract: "sol", decimals: 9, symbol: "SOL" } },
            receive: { amount: "1000000", info: { contract: "token1", decimals: 6, name: "Token1", symbol: "TKN" } },
            createAt: Date.now(),
          },
        ],
      };
    };

    await expect(recoverLivePositions()).resolves.toBeUndefined();
  });
});
