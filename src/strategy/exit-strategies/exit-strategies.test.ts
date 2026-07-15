import { describe, expect, test } from "bun:test";
import { StopLossStrategy } from "./stop-loss";
import { TrailingStopStrategy } from "./trailing-stop";
import { PartialTakeProfitStrategy } from "./partial-tp";
import { TtlStrategy } from "./ttl";
import { PositionExitReason } from "../types";
import type { Position } from "../types";

function makePos(overrides: Partial<Position> = {}): Position {
  const now = Date.now();
  return {
    id: "test_pos",
    pair: "pair1",
    token: "token1",
    tokenName: "TestToken",
    entryPrice: 1,
    sizeSol: 0.1,
    sizeToken: 100,
    openedAt: now,
    currentPrice: 1,
    peakPrice: 1,
    soldPct: 0,
    partialTierIndex: 0,
    status: "open",
    renewedAt: now,
    renewPrice: 1,
    lastUpdateAt: now,
    currentProfitPct: 0,
    lastPriceTimestamp: now,
    priceCurrency: "USD",
    ...overrides,
  };
}

describe("StopLossStrategy", () => {
  test("returns null when disabled", () => {
    const s = new StopLossStrategy(false, -0.15);
    expect(s.check(makePos({ currentProfitPct: -0.2 }), 0)).toBeNull();
  });

  test("returns null when profit is above threshold", () => {
    const s = new StopLossStrategy(true, -0.15);
    expect(s.check(makePos({ currentProfitPct: -0.1 }), 0)).toBeNull();
  });

  test("triggers when profit equals threshold", () => {
    const s = new StopLossStrategy(true, -0.15);
    const r = s.check(makePos({ currentProfitPct: -0.15 }), 0);
    expect(r).not.toBeNull();
    expect(r!.reason).toBe(PositionExitReason.StopLoss);
  });

  test("triggers when profit is below threshold", () => {
    const s = new StopLossStrategy(true, -0.15);
    const r = s.check(makePos({ currentProfitPct: -0.2 }), 0);
    expect(r).not.toBeNull();
    expect(r!.reason).toBe(PositionExitReason.StopLoss);
  });

  test("returns null when profitPct is NaN", () => {
    const s = new StopLossStrategy(true, -0.15);
    expect(s.check(makePos({ currentProfitPct: NaN }), 0)).toBeNull();
  });
});

describe("TrailingStopStrategy", () => {
  test("returns null when activation not met", () => {
    const s = new TrailingStopStrategy(0.2, 0.08);
    const pos = makePos({
      entryPrice: 1,
      peakPrice: 1.1,
      currentProfitPct: 0.05,
    });
    expect(s.check(pos, 0)).toBeNull();
  });

  test("returns null when drawdown is within distance", () => {
    const s = new TrailingStopStrategy(0.2, 0.08);
    const pos = makePos({
      entryPrice: 1,
      peakPrice: 1.5,
      currentProfitPct: 0.45,
    });
    expect(s.check(pos, 0)).toBeNull();
  });

  test("triggers when drawdown exceeds distance after activation", () => {
    const s = new TrailingStopStrategy(0.2, 0.08);
    const pos = makePos({
      entryPrice: 1,
      peakPrice: 1.5,
      currentProfitPct: 0.3,
    });
    const r = s.check(pos, 0);
    expect(r).not.toBeNull();
    expect(r!.reason).toBe(PositionExitReason.TrailingStop);
  });

  test("returns null for non-finite values", () => {
    const s = new TrailingStopStrategy(0.2, 0.08);
    expect(s.check(makePos({ entryPrice: 0, peakPrice: 0 }), 0)).toBeNull();
    expect(s.check(makePos({ entryPrice: NaN }), 0)).toBeNull();
  });
});

describe("PartialTakeProfitStrategy", () => {
  const tiers = [
    { pct: 0.25, at: 0.3 },
    { pct: 0.25, at: 0.6 },
    { pct: 0.25, at: 1.0 },
  ];

  test("returns null when disabled", () => {
    const s = new PartialTakeProfitStrategy(false, tiers);
    expect(s.check(makePos({ currentProfitPct: 0.5 }), 0)).toBeNull();
  });

  test("returns null when no tier is hit", () => {
    const s = new PartialTakeProfitStrategy(true, tiers);
    expect(s.check(makePos({ currentProfitPct: 0.1 }), 0)).toBeNull();
  });

  test("triggers first tier at 30% profit", () => {
    const s = new PartialTakeProfitStrategy(true, tiers);
    const r = s.check(makePos({ currentProfitPct: 0.3 }), 0);
    expect(r).not.toBeNull();
    expect(r!.reason).toBe(PositionExitReason.PartialTP);
    expect(r!.percentage).toBeCloseTo(0.25);
  });

  test("advances tier index on hit", () => {
    const s = new PartialTakeProfitStrategy(true, tiers);
    const pos = makePos({ currentProfitPct: 0.5, partialTierIndex: 0 });
    const r = s.check(pos, 0);
    expect(r!.percentage).toBeCloseTo(0.25);
    expect(pos.partialTierIndex).toBe(1);
  });

  test("triggers remaining tiers in one scan", () => {
    const s = new PartialTakeProfitStrategy(true, tiers);
    const pos = makePos({ currentProfitPct: 2.0, partialTierIndex: 0 });
    const r = s.check(pos, 0);
    expect(r).not.toBeNull();
    expect(r!.percentage).toBeCloseTo(0.75);
    expect(pos.partialTierIndex).toBe(3);
  });

  test("returns null when all tiers consumed", () => {
    const s = new PartialTakeProfitStrategy(true, tiers);
    const pos = makePos({ currentProfitPct: 2.0, partialTierIndex: 3 });
    expect(s.check(pos, 0)).toBeNull();
  });
});

describe("TtlStrategy", () => {
  const base = 60;
  const max = 300;
  const pctChange = 0.08;

  test("returns null when age since renew is less than base TTL", () => {
    const s = new TtlStrategy(base, max, pctChange);
    const pos = makePos({ renewedAt: Date.now() - 30_000 });
    expect(s.check(pos, Date.now())).toBeNull();
  });

  test("triggers expired when total age >= max TTL", () => {
    const s = new TtlStrategy(base, max, pctChange);
    const pos = makePos({
      renewedAt: Date.now() - 120_000,
      openedAt: Date.now() - 300_000,
    });
    const r = s.check(pos, Date.now());
    expect(r).not.toBeNull();
    expect(r!.reason).toBe(PositionExitReason.Expired);
  });

  test("renews position when price change exceeds threshold", () => {
    const s = new TtlStrategy(base, max, pctChange);
    const oldRenew = Date.now() - 120_000;
    const pos = makePos({
      renewedAt: oldRenew,
      renewPrice: 1,
      currentPrice: 1.1,
      openedAt: Date.now() - 120_000,
    });
    const r = s.check(pos, Date.now());
    expect(r).toBeNull();
    expect(pos.renewedAt).toBeGreaterThan(oldRenew);
    expect(pos.renewPrice).toBe(1.1);
  });

  test("triggers expired when not renewed and base TTL passed", () => {
    const s = new TtlStrategy(base, max, pctChange);
    const pos = makePos({
      renewedAt: Date.now() - 120_000,
      currentPrice: 1.01,
      renewPrice: 1,
      openedAt: Date.now() - 120_000,
    });
    const r = s.check(pos, Date.now());
    expect(r).not.toBeNull();
    expect(r!.reason).toBe(PositionExitReason.Expired);
  });
});
