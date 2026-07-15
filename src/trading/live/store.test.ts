import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, mkdtempSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  initLiveStore,
  addOrder,
  getStoreOrders,
  addPosition,
  getStoreOpenPositions,
  closePosition,
  updateOrderMeta,
  type StoredOrder,
} from "./store";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "live-store-test-"));
  dbPath = join(tmpDir, "test.json");
  initLiveStore(dbPath);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const sampleOrder: StoredOrder = {
  id: "order1",
  type: "buy",
  pair: "pair1",
  token: "token1",
  tokenName: "Token1",
  amountSol: 0.1,
  createdAt: Date.now(),
};

describe("initLiveStore", () => {
  test("creates file on first init", () => {
    expect(existsSync(dbPath)).toBe(true);
  });

  test("loads existing data", () => {
    addOrder(sampleOrder);
    const dbPath2 = join(tmpDir, "test2.json");
    initLiveStore(dbPath2);
    addOrder(sampleOrder);
    initLiveStore(dbPath2);
    expect(getStoreOrders()).toHaveLength(1);
  });

  test("handles corrupted file gracefully", () => {
    const dbPath2 = join(tmpDir, "corrupt.json");
    initLiveStore(dbPath2);
    addOrder(sampleOrder);
    initLiveStore(dbPath2);
    expect(getStoreOrders()).toHaveLength(1);
  });
});

describe("addOrder / getStoreOrders", () => {
  test("adds and retrieves orders", () => {
    addOrder(sampleOrder);
    expect(getStoreOrders()).toHaveLength(1);
    expect(getStoreOrders()[0]?.id).toBe("order1");
  });

  test("multiple orders", () => {
    addOrder(sampleOrder);
    addOrder({ ...sampleOrder, id: "order2" });
    expect(getStoreOrders()).toHaveLength(2);
  });
});

describe("addPosition / getStoreOpenPositions / closePosition", () => {
  test("adds open position", () => {
    addPosition({
      orderId: "order1",
      pair: "pair1",
      token: "token1",
      tokenName: "Token1",
      entryPriceUsd: 1.0,
      sizeSol: 0.1,
      status: "open",
      openedAt: Date.now(),
    });
    expect(getStoreOpenPositions()).toHaveLength(1);
  });

  test("closes open position", () => {
    addPosition({
      orderId: "order1",
      pair: "pair1",
      token: "token1",
      tokenName: "Token1",
      entryPriceUsd: 1.0,
      sizeSol: 0.1,
      status: "open",
      openedAt: Date.now(),
    });
    closePosition("pair1", 1.5, "Take Profit");
    const open = getStoreOpenPositions();
    expect(open).toHaveLength(0);
  });

  test("closePosition with zero entry price", () => {
    addPosition({
      orderId: "order1",
      pair: "pair1",
      token: "token1",
      tokenName: "Token1",
      entryPriceUsd: 0,
      sizeSol: 0.1,
      status: "open",
      openedAt: Date.now(),
    });
    closePosition("pair1", 1.5, "Take Profit");
    expect(getStoreOpenPositions()).toHaveLength(0);
  });

  test("addPosition updates existing pair", () => {
    addPosition({
      orderId: "order1",
      pair: "pair1",
      token: "token1",
      tokenName: "Token1",
      entryPriceUsd: 1.0,
      sizeSol: 0.1,
      status: "open",
      openedAt: Date.now(),
    });
    addPosition({
      orderId: "order2",
      pair: "pair1",
      token: "token1",
      tokenName: "Token1",
      entryPriceUsd: 2.0,
      sizeSol: 0.2,
      status: "open",
      openedAt: Date.now(),
    });
    expect(getStoreOpenPositions()).toHaveLength(1);
    expect(getStoreOpenPositions()[0]?.entryPriceUsd).toBe(2.0);
  });
});

describe("updateOrderMeta", () => {
  test("updates token and tokenName", () => {
    addOrder(sampleOrder);
    updateOrderMeta("order1", { token: "new_token", tokenName: "NewName" });
    expect(getStoreOrders()[0]?.token).toBe("new_token");
    expect(getStoreOrders()[0]?.tokenName).toBe("NewName");
  });

  test("ignores missing order", () => {
    updateOrderMeta("nonexistent", { token: "t" });
    expect(getStoreOrders()).toHaveLength(0);
  });
});

describe("order cap", () => {
  test("addOrder beyond cap drops oldest entries", async () => {
    // Add just over the cap to verify trimming works
    for (let i = 0; i < 5010; i++) {
      addOrder({ ...sampleOrder, id: `order_${i}`, createdAt: Date.now() + i });
    }
    const orders = getStoreOrders();
    expect(orders.length).toBeLessThanOrEqual(5000);
    // The oldest entries should be gone, latest retained
    expect(orders.some((o) => o.id === "order_0")).toBe(false);
    expect(orders.some((o) => o.id === "order_5009")).toBe(true);
  }, 30000);
});
