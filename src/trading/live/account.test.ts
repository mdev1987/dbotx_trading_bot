import { describe, expect, test, mock } from "bun:test";

let httpMock = { err: false, res: { account: "test", amount: "10", uiAmount: 5 } };

mock.module("../../config", () => ({ CONFIG: { walletAddress: "test_wallet" } }));
mock.module("../http", () => ({
  dataHttp: { get: async () => httpMock },
}));

import { toTradingAccount, getLiveAccount, fetchLiveBalance } from "./account";

describe("toTradingAccount", () => {
  test("converts balance with solPriceUsd", () => {
    const result = toTradingAccount({ balance: 10 }, 100);
    expect(result.balance).toBe(1000);
  });

  test("zero balance", () => {
    const result = toTradingAccount({ balance: 0 }, 100);
    expect(result.balance).toBe(0);
  });

  test("zero solPrice", () => {
    const result = toTradingAccount({ balance: 10 }, 0);
    expect(result.balance).toBe(0);
  });

  test("sets change fields to 0", () => {
    const result = toTradingAccount({ balance: 10 }, 100);
    expect(result.change24h).toBe(0);
    expect(result.changeAll).toBe(0);
    expect(result.holdTokens).toBe(0);
  });
});

describe("getLiveAccount", () => {
  test("returns default state before fetch", () => {
    const acct = getLiveAccount();
    expect(acct).toEqual({ balance: 0 });
  });
});

describe("fetchLiveBalance", () => {
  test("returns balance from API", async () => {
    httpMock = { err: false, res: { account: "test", amount: "10", uiAmount: 5 } };
    const result = await fetchLiveBalance();
    expect(result.balance).toBe(5);
  });

  test("returns zero when API returns zero", async () => {
    httpMock = { err: false, res: { account: "test", amount: "0", uiAmount: 0 } };
    const result = await fetchLiveBalance();
    expect(result.balance).toBe(0);
  });

  test("does not throw when API errors", async () => {
    httpMock = { err: true, res: { account: "test", amount: "0", uiAmount: 0 } };
    const result = await fetchLiveBalance();
    expect(result.balance).toBe(0);
  });
});
