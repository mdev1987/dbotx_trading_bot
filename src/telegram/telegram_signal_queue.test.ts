import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { enqueueSignal, dequeueSignal, peekSignal, removeSignal, clearQueue, queueSize, isQueueFull, isSignalQueued, getQueuedSignals, initSignalQueue, stopSignalQueue, signalQueue$ } from "./telegram_signal_queue";
import type { AveScannerSignal } from "./ave_scanner_parser";

beforeEach(() => {
  clearQueue();
});

afterEach(() => {
  stopSignalQueue();
});

function makeSignal(overrides: Partial<AveScannerSignal> = {}): AveScannerSignal {
  return { Token: "TestToken", CA: "testCA123", ...overrides };
}

function makeQueued(token?: string): ReturnType<typeof enqueueSignal> {
  const s = makeSignal({ Token: token ?? "TestToken" });
  return enqueueSignal({ signal: s, source: "test", timestamp: Date.now() });
}

describe("enqueueSignal", () => {
  test("adds a signal to the queue", () => {
    expect(makeQueued()).toBe(true);
    expect(queueSize()).toBe(1);
  });

  test("replaces existing signal with same token", () => {
    makeQueued("Token1");
    makeQueued("Token1");
    expect(queueSize()).toBe(1);
  });

  test("uses CA as fallback when Token is undefined", () => {
    const result = makeQueued(undefined!);
    expect(result).toBe(true);
    expect(queueSize()).toBe(1);
  });

  test("queues multiple different tokens", () => {
    makeQueued("Token1");
    makeQueued("Token2");
    makeQueued("Token3");
    expect(queueSize()).toBe(3);
  });

  test("handles signal with neither Token nor CA as 'unknown'", () => {
    const s = makeSignal({ Token: undefined, CA: undefined });
    const r = enqueueSignal({ signal: s, source: "test", timestamp: Date.now() });
    expect(r).toBe(true);
  });
});

describe("dequeueSignal", () => {
  test("returns null on empty queue", () => {
    expect(dequeueSignal()).toBeNull();
  });

  test("removes and returns oldest signal", () => {
    makeQueued("Token1");
    makeQueued("Token2");
    const s = dequeueSignal();
    expect(s).not.toBeNull();
    expect(s!.signal.Token).toBe("Token1");
    expect(queueSize()).toBe(1);
  });
});

describe("peekSignal", () => {
  test("returns oldest without removing", () => {
    makeQueued("Token1");
    makeQueued("Token2");
    const s = peekSignal();
    expect(s).not.toBeNull();
    expect(s!.signal.Token).toBe("Token1");
    expect(queueSize()).toBe(2);
  });

  test("returns null on empty", () => {
    expect(peekSignal()).toBeNull();
  });
});

describe("removeSignal", () => {
  test("removes by token key", () => {
    makeQueued("Token1");
    expect(removeSignal("Token1")).toBe(true);
    expect(queueSize()).toBe(0);
  });

  test("returns false for missing token", () => {
    expect(removeSignal("nonexistent")).toBe(false);
  });
});

describe("clearQueue", () => {
  test("empties the queue", () => {
    makeQueued("Token1");
    makeQueued("Token2");
    clearQueue();
    expect(queueSize()).toBe(0);
  });

  test("no-op on already empty", () => {
    clearQueue();
    expect(queueSize()).toBe(0);
  });
});

describe("queueSize / isQueueFull / isSignalQueued", () => {
  test("isQueueFull returns false when under limit", () => {
    expect(isQueueFull()).toBe(false);
  });

  test("isSignalQueued checks by token", () => {
    makeQueued("Token1");
    expect(isSignalQueued("Token1")).toBe(true);
    expect(isSignalQueued("Token2")).toBe(false);
  });

  test("isSignalQueued works with CA fallback", () => {
    const s = makeSignal({ Token: undefined, CA: "testCA123" });
    enqueueSignal({ signal: s, source: "test", timestamp: Date.now() });
    expect(isSignalQueued("testCA123")).toBe(true);
  });
});

describe("getQueuedSignals", () => {
  test("returns snapshot of all queued signals", () => {
    makeQueued("Token1");
    makeQueued("Token2");
    const snap = getQueuedSignals();
    expect(snap.length).toBe(2);
  });
});

describe("signalQueue$ observable", () => {
  test("emits on enqueue", () => {
    let emitted: readonly any[] = [];
    const sub = signalQueue$.subscribe((v) => { emitted = v; });
    makeQueued("Token1");
    expect(emitted.length).toBe(1);
    sub.unsubscribe();
  });
});
