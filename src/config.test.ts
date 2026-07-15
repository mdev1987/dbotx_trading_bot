import { describe, expect, test } from "bun:test";

// Test the pure functions from config without loading dotenvx
import { parsePartialTpTiers } from "./config";

describe("parsePartialTpTiers", () => {
  test("parses valid tier string", () => {
    const tiers = parsePartialTpTiers("25@30,25@60,50@100");
    expect(tiers).toHaveLength(3);
    expect(tiers[0]).toEqual({ pct: 0.25, at: 0.3 });
    expect(tiers[1]).toEqual({ pct: 0.25, at: 0.6 });
    expect(tiers[2]).toEqual({ pct: 0.5, at: 1.0 });
  });

  test("handles % suffixes", () => {
    const tiers = parsePartialTpTiers("25%@30%,50%@100%");
    expect(tiers).toHaveLength(2);
    expect(tiers[0]).toEqual({ pct: 0.25, at: 0.3 });
    expect(tiers[1]).toEqual({ pct: 0.5, at: 1.0 });
  });

  test("returns empty array for undefined input", () => {
    expect(parsePartialTpTiers(undefined)).toEqual([]);
  });

  test("returns empty array for empty string", () => {
    expect(parsePartialTpTiers("")).toEqual([]);
  });

  test("throws on invalid tier format", () => {
    expect(() => parsePartialTpTiers("invalid")).toThrow();
    expect(() => parsePartialTpTiers("25@")).toThrow();
    expect(() => parsePartialTpTiers("@30")).toThrow();
  });

  test("throws on non-positive values", () => {
    expect(() => parsePartialTpTiers("0@30")).toThrow();
    expect(() => parsePartialTpTiers("25@0")).toThrow();
  });
});
