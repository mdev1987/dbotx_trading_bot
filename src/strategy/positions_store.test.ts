import { describe, expect, test, beforeEach } from "bun:test";
import { addPosition, removePosition, updatePositionPrice, hasPosition, positions } from "./positions_store";
import { PositionExitReason } from "./types";
import * as priceEngine from "../data_stream/price_engine";
import type { PriceInfo } from "../data_stream/types";
import { PriceSource } from "../data_stream/types";

beforeEach(() => {
  positions.clear();
});

describe("addPosition", () => {
  test("creates a position with valid params", () => {
    const pos = addPosition("token1", "pair1", "TestToken", 1.5, 0.1);
    expect(pos).not.toBeNull();
    expect(pos!.token).toBe("token1");
    expect(pos!.pair).toBe("pair1");
    expect(pos!.entryPriceUsd).toBe(1.5);
    expect(pos!.sizeSol).toBe(0.1);
    expect(pos!.status).toBe("open");
    expect(pos!.currentProfitPct).toBe(0);
    expect(pos!.soldPct).toBe(0);
    expect(pos!.partialTierIndex).toBe(0);
  });

  test("returns null for invalid entry price", () => {
    expect(addPosition("token1", "pair1", "TestToken", 0, 0.1)).toBeNull();
    expect(addPosition("token1", "pair1", "TestToken", -1, 0.1)).toBeNull();
    expect(addPosition("token1", "pair1", "TestToken", NaN, 0.1)).toBeNull();
  });

  test("stores position keyed by pair", () => {
    addPosition("token1", "pair1", "TestToken", 1.5, 0.1);
    expect(positions.has("pair1")).toBe(true);
  });
});

describe("removePosition", () => {
  test("removes and returns closed position", () => {
    addPosition("token1", "pair1", "TestToken", 1.5, 0.1);
    const removed = removePosition("pair1", 2.0, PositionExitReason.TakeProfit);
    expect(removed).not.toBeNull();
    expect(removed!.status).toBe("closed");
    expect(removed!.closePriceUsd).toBe(2.0);
    expect(removed!.reason).toBe(PositionExitReason.TakeProfit);
    expect(removed!.closedAt).toBeGreaterThan(0);
    expect(positions.has("pair1")).toBe(false);
  });

  test("returns null for non-existent pair", () => {
    expect(removePosition("nonexistent")).toBeNull();
  });

  test("uses currentPriceUsd when no closePrice given", () => {
    addPosition("token1", "pair1", "TestToken", 1.5, 0.1);
    const pos = positions.get("pair1")!;
    pos.currentPriceUsd = 2.5;
    const removed = removePosition("pair1");
    expect(removed!.closePriceUsd).toBe(2.5);
  });
});

describe("updatePositionPrice", () => {
  test("updates current price and profit", () => {
    addPosition("token1", "pair1", "TestToken", 1.0, 0.1);
    const pos = positions.get("pair1")!;
    pos.lastPriceTimestamp = 0;
    const update: PriceInfo = {
      token: "token1",
      pair: "pair1",
      priceUsd: 1.5,
      source: PriceSource.PUMPAPI,
      timestamp: 1000,
    };
    updatePositionPrice(update);
    expect(pos.currentPriceUsd).toBe(1.5);
    expect(pos.currentProfitPct).toBeCloseTo(0.5);
  });

  test("ignores stale updates", () => {
    addPosition("token1", "pair1", "TestToken", 1.0, 0.1);
    const pos = positions.get("pair1")!;
    pos.lastPriceTimestamp = 1000;
    const stale: PriceInfo = {
      token: "token1",
      pair: "pair1",
      priceUsd: 2.0,
      source: PriceSource.PUMPAPI,
      timestamp: 500,
    };
    updatePositionPrice(stale);
    expect(pos.currentPriceUsd).toBe(1.0);
  });

  test("tracks peak price", () => {
    addPosition("token1", "pair1", "TestToken", 1.0, 0.1);
    const pos = positions.get("pair1")!;
    pos.lastPriceTimestamp = 0;
    const update1: PriceInfo = { token: "token1", pair: "pair1", priceUsd: 2.0, source: PriceSource.PUMPAPI, timestamp: 2000 };
    updatePositionPrice(update1);
    const update2: PriceInfo = { token: "token1", pair: "pair1", priceUsd: 1.5, source: PriceSource.PUMPAPI, timestamp: 3000 };
    updatePositionPrice(update2);
    expect(pos.peakPriceUsd).toBe(2.0);
  });

  test("ignores invalid prices", () => {
    addPosition("token1", "pair1", "TestToken", 1.0, 0.1);
    const pos = positions.get("pair1")!;
    pos.lastPriceTimestamp = 0;
    const bad: PriceInfo = { token: "token1", pair: "pair1", priceUsd: -1, source: PriceSource.PUMPAPI, timestamp: 1000 };
    updatePositionPrice(bad);
    expect(pos.currentPriceUsd).toBe(1.0);
  });
});

describe("hasPosition", () => {
  test("returns true for existing pair", () => {
    addPosition("token1", "pair1", "TestToken", 1.0, 0.1);
    expect(hasPosition("pair1")).toBe(true);
  });

  test("returns false after removal", () => {
    addPosition("token1", "pair1", "TestToken", 1.0, 0.1);
    removePosition("pair1");
    expect(hasPosition("pair1")).toBe(false);
  });
});
