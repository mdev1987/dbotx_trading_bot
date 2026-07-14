import { describe, expect, test } from "bun:test";
import { exitLabel, toExitReason, type TradeResultNotification } from "./trade-ws";
import { PositionExitReason } from "../../strategy/types";

describe("exitLabel", () => {
  test('returns "Take Profit" for take_profit source', () => {
    expect(exitLabel("swap_take_profit")).toBe("Take Profit");
  });

  test('returns "Stop Loss" for stop_loss source', () => {
    expect(exitLabel("swap_stop_loss")).toBe("Stop Loss");
  });

  test('returns "Trailing Stop" for trailing_stop source', () => {
    expect(exitLabel("swap_trailing_stop")).toBe("Trailing Stop");
  });

  test('returns "Sell" for swap_order source', () => {
    expect(exitLabel("swap_order")).toBe("Sell");
  });

  test('returns "Sell" for unknown source', () => {
    expect(exitLabel("unknown")).toBe("Sell");
  });

  test('returns "Take Profit" for follow_take_profit', () => {
    expect(exitLabel("follow_take_profit")).toBe("Take Profit");
  });

  test('returns "Stop Loss" for follow_stop_loss', () => {
    expect(exitLabel("follow_stop_loss")).toBe("Stop Loss");
  });
});

describe("toExitReason", () => {
  const makeNotif = (subSource?: string | null): TradeResultNotification => ({
    id: "test",
    state: "done",
    source: "swap_order",
    subSource,
    chain: "solana",
    type: "sell",
    token: "token1",
    pair: "pair1",
    symbol: "TKN",
  });

  test("maps swap_take_profit to TakeProfit", () => {
    expect(toExitReason(makeNotif("swap_take_profit"))).toBe(PositionExitReason.TakeProfit);
  });

  test("maps swap_stop_loss to StopLoss", () => {
    expect(toExitReason(makeNotif("swap_stop_loss"))).toBe(PositionExitReason.StopLoss);
  });

  test("maps swap_trailing_stop to TrailingStop", () => {
    expect(toExitReason(makeNotif("swap_trailing_stop"))).toBe(PositionExitReason.TrailingStop);
  });

  test("returns undefined for null subSource", () => {
    expect(toExitReason(makeNotif(null))).toBeUndefined();
  });

  test("returns undefined for undefined subSource", () => {
    expect(toExitReason(makeNotif(undefined))).toBeUndefined();
  });

  test("returns undefined for swap_order", () => {
    expect(toExitReason(makeNotif())).toBeUndefined();
  });
});
