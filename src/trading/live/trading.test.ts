import { describe, expect, test } from "bun:test";
import { buildStopEarnGroup, submitSell } from "./trading";

describe("buildStopEarnGroup", () => {
  test("single tier", () => {
    const result = buildStopEarnGroup([{ pct: 0.5, at: 0.2 }], 0);
    expect(result).toEqual([{ pricePercent: 0.2, amountPercent: 0.5 }]);
  });

  test("multiple tiers", () => {
    const result = buildStopEarnGroup(
      [
        { pct: 0.5, at: 0.2 },
        { pct: 0.5, at: 0.5 },
      ],
      0,
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ pricePercent: 0.2, amountPercent: 0.5 });
    expect(result[1]).toEqual({ pricePercent: 0.5, amountPercent: 0.5 });
  });

  test("adds backstop when remaining > 0", () => {
    const result = buildStopEarnGroup([{ pct: 0.5, at: 0.2 }], 0.8);
    expect(result).toHaveLength(2);
    expect(result[1]).toEqual({ pricePercent: 0.8, amountPercent: 0.5 });
  });

  test("no backstop when tiers sum to 1", () => {
    const result = buildStopEarnGroup([{ pct: 1, at: 0.2 }], 0.8);
    expect(result).toHaveLength(1);
  });

  test("no backstop when backstopPct is 0", () => {
    const result = buildStopEarnGroup([{ pct: 0.5, at: 0.2 }], 0);
    expect(result).toHaveLength(1);
  });

  test("empty tiers returns empty group", () => {
    const result = buildStopEarnGroup([], 0);
    expect(result).toHaveLength(0);
  });
});

describe("submitSell validation", () => {
  test("throws on percentage = 0", async () => {
    await expect(submitSell("pair", 0)).rejects.toThrow("Sell percentage must be between 0 and 1");
  });

  test("throws on percentage < 0", async () => {
    await expect(submitSell("pair", -0.1)).rejects.toThrow("Sell percentage must be between 0 and 1");
  });

  test("throws on percentage > 1", async () => {
    await expect(submitSell("pair", 1.5)).rejects.toThrow("Sell percentage must be between 0 and 1");
  });
});
