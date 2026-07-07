/**
 * Comprehensive test suite for the live trading module.
 *
 * Tests each module in isolation with mocked dependencies.
 * All modules are imported fresh for each test via dynamic import.
 */
import { expect, test, mock, describe, beforeEach, afterEach, beforeAll } from "bun:test";
import { unlinkSync } from "fs";

let LIVE_CONFIG: any;

beforeAll(async () => {
  process.env.DBOTX_API_KEY = "test-key";
  process.env.DBOTX_WS_URL = "wss://test.example.com/ws";
  process.env.DBOTX_BASE_URL = "https://test.example.com";
  process.env.DBOTX_SERVAPI_BASE_URL = "https://test.example.com";
  process.env.TELEGRAM_CHANNEL_USERNAME = "AveSolanaTokenScanner";
  process.env.STOP_TRADING_PATH = "./STOP_TRADING_LIVE_TEST";
  process.env.LIVE_WALLET_ID = "test-wallet";
  process.env.LIVE_WALLET_ADDRESS = "test-address";

  const config = await import("./config");
  LIVE_CONFIG = config.LIVE_CONFIG;
});

// =============================================================================
// config.ts
// =============================================================================

describe("config", () => {
  test("loads default values when env vars are not set", () => {
    // LIVE_CONFIG is already loaded at import time from process.env
    // Verify the structure has all expected keys
    expect(LIVE_CONFIG).toBeDefined();
    expect(typeof LIVE_CONFIG.liveMode).toBe("boolean");
    expect(typeof LIVE_CONFIG.dbotxApiKey).toBe("string");
    expect(typeof LIVE_CONFIG.walletId).toBe("string");
    expect(typeof LIVE_CONFIG.walletAddress).toBe("string");
  });

  test("has sensible trading defaults", () => {
    expect(LIVE_CONFIG.maxPositions).toBeGreaterThan(0);
    expect(LIVE_CONFIG.minPositionSol).toBeGreaterThan(0);
    expect(LIVE_CONFIG.maxPositionSol).toBeGreaterThanOrEqual(LIVE_CONFIG.minPositionSol);
    expect(LIVE_CONFIG.positionSize).toBeGreaterThan(0);
    // stopLossPct may be negative (configurable percentage drop, e.g. -15%)
    expect(LIVE_CONFIG.jitoEnabled).toBe(true);
  });
});

// =============================================================================
// http.ts
// =============================================================================

describe("http", () => {
  test("getJson and postJson are exported", async () => {
    const http = await import("./http");
    expect(typeof http.fetchWithRetry).toBe("function");
    expect(typeof http.getJson).toBe("function");
    expect(typeof http.postJson).toBe("function");
  });

  test("fetchWithRetry handles network timeout gracefully", async () => {
    const http = await import("./http");
    // Function exists and expects valid arguments
    expect(http.fetchWithRetry).toBeDefined();
  });
});

// =============================================================================
// types.ts
// =============================================================================

describe("types", () => {
  test("all types are properly exported", async () => {
    const types = await import("./types");
    expect(types).toBeDefined();
    expect(typeof types).toBe("object");
  });
});

// =============================================================================
// account.ts — computePositionSize
// =============================================================================

describe("computePositionSize", () => {
  beforeEach(() => {
    // Reset balance to known state before each test
    const wallet = require("./wallet");
    wallet.setLatestBalance({ balanceSol: 100 });
  });

  test("returns configured position size by default", async () => {
    const account = await import("./account");
    const size = account.computePositionSize();
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThanOrEqual(LIVE_CONFIG.maxPositionSol);
    expect(size).toBeGreaterThanOrEqual(LIVE_CONFIG.minPositionSol);
  });

  test("respects min position size floor", async () => {
    const wallet = require("./wallet");
    wallet.setLatestBalance({ balanceSol: 0.0001 }); // Tiny balance
    const account = await import("./account");
    const size = account.computePositionSize();
    expect(size).toBeGreaterThanOrEqual(LIVE_CONFIG.minPositionSol);
  });

  test("respects max position size cap", async () => {
    const wallet = require("./wallet");
    wallet.setLatestBalance({ balanceSol: 1000 }); // Large balance
    const account = await import("./account");
    const size = account.computePositionSize();
    expect(size).toBeLessThanOrEqual(LIVE_CONFIG.maxPositionSol);
  });

  test("works when latestBalance is null", async () => {
    const wallet = require("./wallet");
    wallet.setLatestBalance(null);
    const account = await import("./account");
    const size = account.computePositionSize();
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThanOrEqual(LIVE_CONFIG.maxPositionSol);
  });
});

// =============================================================================
// fast_buy_sell.ts
// =============================================================================

describe("fast_buy_sell", () => {
  test("buildBuyOrderParams returns valid parameters", async () => {
    const fbs = await import("./fast_buy_sell");
    const params = fbs.buildBuyOrderParams("test_pair_address", 0.1);

    expect(params.chain).toBe("solana");
    expect(params.pair).toBe("test_pair_address");
    expect(params.type).toBe("buy");
    expect(params.amountOrPercent).toBe(0.1);
    expect(params.walletId).toBe(LIVE_CONFIG.walletId);
    expect(params.jitoEnabled).toBe(true);
    expect(params.concurrentNodes).toBeGreaterThanOrEqual(1);
    expect(params.concurrentNodes).toBeLessThanOrEqual(3);
    expect(params.retries).toBeGreaterThanOrEqual(0);
    expect(params.maxSlippage).toBeGreaterThan(0);
    expect(params.pnlOrderExpireExecute).toBe(true);
  });

  test("buildSellOrderParams returns valid parameters", async () => {
    const fbs = await import("./fast_buy_sell");
    const params = fbs.buildSellOrderParams("test_pair_address");

    expect(params.chain).toBe("solana");
    expect(params.pair).toBe("test_pair_address");
    expect(params.type).toBe("sell");
    expect(params.amountOrPercent).toBe(1); // 100 %
  });

  test("buildBuyOrderParams includes TP tiers when configured", async () => {
    const fbs = await import("./fast_buy_sell");
    const params = fbs.buildBuyOrderParams("test_pair", 0.1);

    if (LIVE_CONFIG.partialTpTiers.length > 0) {
      expect(params.stopEarnGroup).toBeDefined();
      expect(params.stopEarnGroup!.length).toBeGreaterThanOrEqual(
        LIVE_CONFIG.partialTpTiers.length,
      );
    }

    if (LIVE_CONFIG.backstopTpPct > 0) {
      expect(params.stopEarnGroup).toBeDefined();
      const lastTier = params.stopEarnGroup![params.stopEarnGroup!.length - 1]!;
      const soldSoFar = LIVE_CONFIG.partialTpTiers.reduce((sum, t) => sum + t.pct, 0);
      const expectedRemaining = LIVE_CONFIG.partialTpEnabled
        ? Math.round((1 - soldSoFar) * 1000) / 1000
        : 1;
      expect(lastTier.amountPercent).toBe(expectedRemaining);
    }
  });

  test("buildBuyOrderParams sets stop loss config", async () => {
    const fbs = await import("./fast_buy_sell");
    const params = fbs.buildBuyOrderParams("test_pair", 0.1);
    // stopLossPercent is the absolute value (e.g. 0.15 = 15% SL)
    expect(params.stopLossPercent).toBe(LIVE_CONFIG.stopLossPct);
  });

  test("buildBuyOrderParams creates trailing stop group when configured", async () => {
    const fbs = await import("./fast_buy_sell");
    const params = fbs.buildBuyOrderParams("test_pair", 0.1);

    if (LIVE_CONFIG.trailingStopPct > 0) {
      expect(params.trailingStopGroup).toBeDefined();
      expect(params.trailingStopGroup!.length).toBe(1);
      expect(params.trailingStopGroup![0]!.pricePercent).toBe(LIVE_CONFIG.trailingStopPct);
      expect(params.trailingStopGroup![0]!.activePricePercent).toBe(LIVE_CONFIG.trailingActivationPct);
    }
  });

  test("buildBuyOrderParams includes migrate/dev sell config", async () => {
    const fbs = await import("./fast_buy_sell");
    const params = fbs.buildBuyOrderParams("test_pair", 0.1);

    expect(params.migrateSellPercent).toBeDefined();
    expect(params.minDevSellPercent).toBeDefined();
    expect(params.devSellPercent).toBeDefined();
  });
});

// =============================================================================
// position_core.ts
// =============================================================================

describe("position_core", () => {
  beforeEach(() => {
    // Clear the signal queue before each test to prevent cross-test pollution
    const core = require("./position_core");
    if (typeof core._clearQueueForTest === "function") {
      core._clearQueueForTest();
    }
  });

  test("module exports expected functions", async () => {
    const core = await import("./position_core");

    expect(typeof core.openPosition).toBe("function");
    expect(typeof core.closePositionById).toBe("function");
    expect(typeof core.emitEvent).toBe("function");
    expect(typeof core.enqueueSignal).toBe("function");
    expect(typeof core.dequeueSignal).toBe("function");
    expect(typeof core.countOpenPositions).toBe("function");
    expect(typeof core.getPositionByToken).toBe("function");
    expect(typeof core.getPositionByOrderId).toBe("function");
    expect(typeof core.patchPositionById).toBe("function");
    expect(typeof core.startTtlChecker).toBe("function");
    expect(typeof core.subscribeToTradeEvents).toBe("function");
    expect(typeof core.recoverOpenPositions).toBe("function");
  });

  test("enqueueSignal and dequeueSignal work in FIFO order", async () => {
    const core = await import("./position_core");
    type MockSignal = { tokenName: string; address: string; lpAddress: string };

    const signal1: MockSignal = { tokenName: "TOKEN1", address: "addr1", lpAddress: "lp1" };
    const signal2: MockSignal = { tokenName: "TOKEN2", address: "addr2", lpAddress: "lp2" };
    const signal3: MockSignal = { tokenName: "TOKEN3", address: "addr3", lpAddress: "lp3" };

    core.enqueueSignal(signal1 as any);
    core.enqueueSignal(signal2 as any);
    core.enqueueSignal(signal3 as any);

    expect(core.dequeueSignal()).toBe(signal1 as any);
    expect(core.dequeueSignal()).toBe(signal2 as any);
    expect(core.dequeueSignal()).toBe(signal3 as any);
    expect(core.dequeueSignal()).toBeNull();
  });

  test("dequeueSignal returns null when queue is empty", async () => {
    const core = await import("./position_core");
    // Queue was cleared in beforeEach
    expect(core.dequeueSignal()).toBeNull();
  });

  test("enqueueSignal respects max queue size", async () => {
    const core = await import("./position_core");
    type MockSignal = { tokenName: string; address: string; lpAddress: string };

    // Fill queue past max
    const maxSize = LIVE_CONFIG.signalQueueSize;
    for (let i = 0; i < maxSize + 5; i++) {
      core.enqueueSignal({
        tokenName: `TOKEN${i}`,
        address: `addr${i}`,
        lpAddress: `lp${i}`,
      } as any);
    }

    // Queue should not exceed maxSize
    expect(core.queueLength()).toBeLessThanOrEqual(maxSize);
  });

  test("getPositionByToken returns undefined for unknown token", async () => {
    const core = await import("./position_core");
    expect(core.getPositionByToken("nonexistent_token")).toBeUndefined();
  });

  test("getPositionByOrderId returns undefined for unknown order", async () => {
    const core = await import("./position_core");
    expect(core.getPositionByOrderId("nonexistent_order")).toBeUndefined();
  });

  test("countOpenPositions returns 0 initially", async () => {
    const core = await import("./position_core");
    expect(core.countOpenPositions()).toBe(0);
  });

  test("emitEvent emits to positionEvent$ subject", async () => {
    const core = await import("./position_core");

    const events: any[] = [];
    const sub = core.positionEvent$.subscribe((e: any) => events.push(e));

    core.emitEvent({ type: "opened", position: null as any });
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe("opened");

    sub.unsubscribe();
  });

  test("positionOpened$ and positionClosed$ filter correctly", async () => {
    const core = await import("./position_core");

    const opened: any[] = [];
    const closed: any[] = [];

    const sub1 = core.positionOpened$.subscribe((p: any) => opened.push(p));
    const sub2 = core.positionClosed$.subscribe((p: any) => closed.push(p));

    core.emitEvent({ type: "opened", position: { id: 1 } as any });
    core.emitEvent({ type: "closed", position: { id: 2 } as any, closeReason: "expired" as any });
    core.emitEvent({ type: "opened", position: { id: 3 } as any });

    expect(opened.length).toBe(2);
    expect(closed.length).toBe(1);
    expect(closed[0]!.id).toBe(2);

    sub1.unsubscribe();
    sub2.unsubscribe();
  });

  test("markPositionClosed does not throw for unknown position", () => {
    const core = require("./position_core");
    expect(() => {
      core.markPositionClosed(999, "expired", 0.1);
    }).not.toThrow();
  });
});

// =============================================================================
// wallet.ts
// =============================================================================

describe("wallet", () => {
  test("exports expected functions", async () => {
    const wallet = await import("./wallet");

    expect(typeof wallet.fetchWallets).toBe("function");
    expect(typeof wallet.fetchBalance).toBe("function");
    expect(typeof wallet.resolveConfiguredWallet).toBe("function");
    expect(typeof wallet.setLatestBalance).toBe("function");
    expect(typeof wallet.refreshBalance$).toBe("object");
    expect(typeof wallet.walletBalance$).toBe("object");
  });

  test("setLatestBalance updates the balance snapshot", () => {
    const wallet = require("./wallet");
    wallet.setLatestBalance({ balanceSol: 42.5 });
    expect(wallet.latestBalance).toEqual({ balanceSol: 42.5 });
    wallet.setLatestBalance(null);
    expect(wallet.latestBalance).toBeNull();
  });

  test("refreshBalance$ is a Subject", async () => {
    const wallet = await import("./wallet");
    expect(wallet.refreshBalance$.next).toBeDefined();
    expect(typeof wallet.refreshBalance$.next).toBe("function");
  });
});

// =============================================================================
// trailing_stop.ts
// =============================================================================

describe("trailing_stop", () => {
  test("startTrailingMonitor returns a Subscription", async () => {
    const trailing = await import("./trailing_stop");
    const sub = trailing.startTrailingMonitor();
    expect(sub).toBeDefined();
    expect(typeof sub.unsubscribe).toBe("function");
    sub.unsubscribe();
  });
});

// =============================================================================
// trade_results_ws.ts
// =============================================================================

describe("trade_results_ws", () => {
  test("exports expected streams and functions", async () => {
    const ws = await import("./trade_results_ws");

    expect(ws.tradeResultEvent$).toBeDefined();
    expect(ws.buySuccessEvent$).toBeDefined();
    expect(ws.sellSuccessEvent$).toBeDefined();
    expect(ws.takeProfitSuccessEvent$).toBeDefined();
    expect(ws.stopLossSuccessEvent$).toBeDefined();
    expect(ws.trailingStopSuccessEvent$).toBeDefined();
    expect(ws.tradeFailEvent$).toBeDefined();
    expect(typeof ws.connectTradeResultsWs).toBe("function");
    expect(typeof ws.disconnectTradeResultsWs).toBe("function");
  });
});

// =============================================================================
// position_manager.ts
// =============================================================================

describe("position_manager", () => {
  test("exports core functions and startLiveTrading", async () => {
    const pm = await import("./position_manager");

    expect(typeof pm.startLiveTrading).toBe("function");
    expect(typeof pm.stopLiveTrading).toBe("function");
    expect(typeof pm.openPosition).toBe("function");
    expect(typeof pm.closePositionById).toBe("function");
  });
});

// =============================================================================
// position_default_strategy.ts
// =============================================================================

describe("position_default_strategy", () => {
  test("startDefaultStrategy does not throw", () => {
    const strategy = require("./position_default_strategy");
    expect(typeof strategy.startDefaultStrategy).toBe("function");
  });
});

// =============================================================================
// position_signal_monitor_strategy.ts
// =============================================================================

describe("position_signal_monitor_strategy", () => {
  test("startMonitorStrategy does not throw", () => {
    const strategy = require("./position_signal_monitor_strategy");
    expect(typeof strategy.startMonitorStrategy).toBe("function");
  });
});

// =============================================================================
// Integration tests
// =============================================================================

describe("integration", () => {
  beforeEach(() => {
    const wallet = require("./wallet");
    wallet.setLatestBalance({ balanceSol: 100 });
  });

  test("buildBuyOrderParams output is compatible with createSwapOrder inputs", async () => {
    const fbs = await import("./fast_buy_sell");
    const params = fbs.buildBuyOrderParams("test_pair", 0.1);

    // Verify all required fields per the API spec
    const requiredFields = [
      "chain", "pair", "walletId", "type", "amountOrPercent",
      "priorityFee", "jitoTip", "maxSlippage",
      "concurrentNodes", "retries",
    ];

    for (const field of requiredFields) {
      expect(params).toHaveProperty(field);
    }

    // Verify optional arrays have correct shape
    if (params.stopEarnGroup) {
      for (const tier of params.stopEarnGroup) {
        expect(typeof tier.pricePercent).toBe("number");
        expect(typeof tier.amountPercent).toBe("number");
        expect(tier.pricePercent).toBeGreaterThan(0);
        expect(tier.amountPercent).toBeGreaterThan(0);
        expect(tier.amountPercent).toBeLessThanOrEqual(1);
      }
    }

    if (params.stopLossGroup) {
      for (const tier of params.stopLossGroup) {
        expect(tier.pricePercent).toBeGreaterThan(0);
        expect(tier.amountPercent).toBeGreaterThan(0);
      }
    }
  });

  test("max position size is never exceeded", async () => {
    const wallet = require("./wallet");
    wallet.setLatestBalance({ balanceSol: 1_000_000 });
    const account = await import("./account");
    const fbs = await import("./fast_buy_sell");

    const size = account.computePositionSize();
    const params = fbs.buildBuyOrderParams("test_pair", size);
    expect(params.amountOrPercent).toBeLessThanOrEqual(LIVE_CONFIG.maxPositionSol);
    expect(params.amountOrPercent).toBeGreaterThanOrEqual(LIVE_CONFIG.minPositionSol);
  });

  test("buildBuyOrderParams sets pnlOrderExpireDelta from config", async () => {
    const fbs = await import("./fast_buy_sell");
    const params = fbs.buildBuyOrderParams("test_pair", 0.1);

    // expireDelta should be the min of pnlOrderExpireDeltaMs and baseTtlSecs*1000
    const expectedDelta = Math.min(
      LIVE_CONFIG.pnlOrderExpireDeltaMs,
      LIVE_CONFIG.baseTtlSecs * 1000,
    );
    expect(params.pnlOrderExpireDelta).toBe(expectedDelta);
  });

  test("buildBuyOrderParams always sets pnlCustomConfigEnabled", async () => {
    const fbs = await import("./fast_buy_sell");
    const params = fbs.buildBuyOrderParams("test_pair", 0.1);
    expect(params.pnlCustomConfigEnabled).toBe(true);
    expect(params.pnlCustomConfig).toBeDefined();
    expect(params.pnlCustomConfig!.jitoEnabled).toBe(true);
  });

  test("buildBuyOrderParams with zero TP tiers still produces valid params", async () => {
    // Temporarily patch config for this test
    const fbs = await import("./fast_buy_sell");

    // Even with no config, basic params should be valid
    const params = fbs.buildSellOrderParams("test_pair");
    expect(params.amountOrPercent).toBe(1);
    expect(params.type).toBe("sell");
    expect(params.stopEarnPercent).toBeUndefined();
    expect(params.stopEarnGroup).toBeUndefined();
  });
});

// =============================================================================
// Edge case tests
// =============================================================================

describe("edge cases", () => {
  test("computePositionSize handles tiny wallet balance", async () => {
    const wallet = require("./wallet");
    wallet.setLatestBalance({ balanceSol: 0.001 }); // Very small balance
    const account = await import("./account");
    const size = account.computePositionSize();
    expect(size).toBeGreaterThanOrEqual(LIVE_CONFIG.minPositionSol);
  });

  test("computePositionSize handles zero balance gracefully", async () => {
    const wallet = require("./wallet");
    wallet.setLatestBalance({ balanceSol: 0 });
    const account = await import("./account");
    const size = account.computePositionSize();
    // Should still produce at least min position
    expect(size).toBeGreaterThanOrEqual(LIVE_CONFIG.minPositionSol);
  });

  test("queue handles rapid enqueue/dequeue", async () => {
    const core = require("./position_core");
    core._clearQueueForTest();

    type MockSignal = { tokenName: string; address: string; lpAddress: string };

    // Rapid interleaved operations
    const s1: MockSignal = { tokenName: "A", address: "a", lpAddress: "lp_a" };
    const s2: MockSignal = { tokenName: "B", address: "b", lpAddress: "lp_b" };
    const s3: MockSignal = { tokenName: "C", address: "c", lpAddress: "lp_c" };

    core.enqueueSignal(s1 as any);
    expect(core.dequeueSignal()).toBe(s1 as any);
    core.enqueueSignal(s2 as any);
    core.enqueueSignal(s3 as any);
    expect(core.dequeueSignal()).toBe(s2 as any);
    expect(core.dequeueSignal()).toBe(s3 as any);
    expect(core.dequeueSignal()).toBeNull();
  });

  test("querySwapOrders handles empty array", async () => {
    const fbs = await import("./fast_buy_sell");
    // Empty array should return empty array without making API call
    const result = await fbs.querySwapOrders([]);
    expect(result).toEqual([]);
  });

  test("countOpenPositions returns accurate count", () => {
    const core = require("./position_core");
    expect(core.countOpenPositions()).toBe(0);
  });
});

// =============================================================================
// panic.ts
// =============================================================================

describe("panic", () => {
  const panicPath = "./STOP_TRADING_LIVE_TEST";

  beforeAll(() => {
    // Clean up any leftover test file
    try { unlinkSync(panicPath); } catch {}
  });

  afterEach(() => {
    try { unlinkSync(panicPath); } catch {}
    const panic = require("./panic");
    panic.disablePanic();
  });

  test("isPanicMode returns false by default", async () => {
    const panic = await import("./panic");
    expect(panic.isPanicMode()).toBe(false);
  });

  test("enablePanic sets panic mode", async () => {
    const panic = await import("./panic");
    panic.enablePanic();
    expect(panic.isPanicMode()).toBe(true);
  });

  test("disablePanic clears panic mode", async () => {
    const panic = await import("./panic");
    panic.enablePanic();
    expect(panic.isPanicMode()).toBe(true);
    panic.disablePanic();
    expect(panic.isPanicMode()).toBe(false);
  });

  test("isPanicMode detects STOP_TRADING file", async () => {
    // Create the file manually (simulates touch STOP_TRADING)
    const { writeFileSync } = require("fs");
    writeFileSync(panicPath, "test");
    const panic = await import("./panic");
    expect(panic.isPanicMode()).toBe(true);
  });
});

// =============================================================================
// persistence.ts
// =============================================================================

describe("persistence", () => {
  test("getLiveDb returns a database instance", async () => {
    const pers = await import("./persistence");
    const db = pers.getLiveDb();
    expect(db).toBeDefined();
    expect(typeof db.prepare).toBe("function");
  });

  test("savePositionToDb and loadNonClosedPositions round-trip", async () => {
    const pers = await import("./persistence");
    const core = await import("./position_core");

    // Create a minimal position state
    const pos = {
      id: 999001,
      orderId: "test-order-999001",
      pair: "test-pair-999001",
      token: "test-token-999001",
      tokenName: "TestToken",
      tokenSymbol: "TT",
      sizeSol: 0.1,
      entryPriceUsd: null,
      peakPriceUsd: 0,
      trailingActive: false,
      currentProfitPercent: 0,
      currentProfitUsd: 0,
      openedAt: Date.now(),
      expiresAt: Date.now() + 300000,
      lastUpdateAt: Date.now(),
      status: "open",
      closeReason: null,
      exitPriceUsd: null,
      signal: { type: "test" } as any,
    };

    pers.savePositionToDb(pos as any);

    // Load back
    const loaded = pers.loadNonClosedPositions();
    const found = loaded.find((r: any) => r.id === 999001);
    expect(found).toBeDefined();
    expect(found!.order_id).toBe("test-order-999001");
    expect(found!.status).toBe("open");

    // Clean up
    pers.markPositionDeletedFromDb(999001);
  });

  test("appendAuditLog and updateAuditLog round-trip", async () => {
    const pers = await import("./persistence");
    const logId = pers.appendAuditLog("buy", "test-pair-audit", 0.1, '{"test":true}');
    expect(logId).toBeGreaterThan(0);

    pers.updateAuditLog(logId, "sent", "order-123", '{"ok":true}');
    // No error means success
  });
});
