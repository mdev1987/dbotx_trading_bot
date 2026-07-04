/**
 * Signal deduplication and acceptance pipeline for incoming trading signals.
 *
 * Architecture
 * -----------
 * This module uses an **event-driven reducer** (scan-based state machine) to
 * deduplicate signals by LP address and manage their lifecycle. A periodic
 * tick stream triggers cleanup of stale entries from the LRU-like cache.
 *
 * Why not distinctUntilChanged?
 * ------------------------------
 * A simple distinctUntilChanged would only suppress consecutive duplicates.
 * We need to suppress **all** repeats of the same LP address, even if they
 * arrive interleaved with other pairs.  The reducer / scan approach gives us
 * that cross-signal deduplication window for free.
 */

import { Subject, Observable, interval, merge } from "rxjs";
import { filter, map, scan, shareReplay } from "rxjs/operators";
import { telegramSignal$, type ParsedSignal } from "./telegram_listener";
import type { AveScannerSignal } from "./ave_scanner_parser";
import { CONFIG } from "../config";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return the current Unix timestamp in seconds. */
const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/**
 * Map of LP address → Unix timestamp (seconds) when the signal was first
 * accepted into the system.
 *
 * Only entries that are still within the TTL window (CONFIG.signalCacheTtlSeconds)
 * are retained.  Stale entries are evicted on the next tick cycle.
 */
type ActiveSignalMap = Map<string, number>;

// ---------------------------------------------------------------------------
// Internal event types (processed by the reducer)
// ---------------------------------------------------------------------------

/**
 * A new signal arrived from the Telegram listener and needs to be evaluated
 * for deduplication against the current active set.
 */
interface SignalEvent {
  /** Discriminant field identifying this as a signal event */
  readonly type: "signal";
  /** The parsed signal payload to process */
  readonly signal: ParsedSignal;
  /** The Unix timestamp (seconds) at which the event was created */
  readonly now: number;
}

/**
 * Periodic clock tick that triggers cleanup of expired entries from the
 * active-signal cache.
 */
interface TickEvent {
  /** Discriminant field identifying this as a tick event */
  readonly type: "tick";
  /** The Unix timestamp (seconds) at which the tick was emitted */
  readonly now: number;
}

/** Union of all event types the state reducer can process. */
type EngineEvent = SignalEvent | TickEvent;

// ---------------------------------------------------------------------------
// Event factories (testable in isolation)
// ---------------------------------------------------------------------------

/**
 * Create a SignalEvent from a parsed signal.
 *
 * Factory is kept as a named function so it can be unit-tested independently
 * of the observable pipeline.
 *
 * @param signal - The incoming parsed signal.
 * @returns A SignalEvent with the current timestamp.
 */
const createSignalEvent = (signal: ParsedSignal): SignalEvent => ({
  type: "signal",
  signal,
  now: nowSeconds(),
});

/**
 * Create a TickEvent for the current clock cycle.
 *
 * @returns A TickEvent with the current timestamp.
 */
const createTickEvent = (): TickEvent => ({
  type: "tick",
  now: nowSeconds(),
});

// ---------------------------------------------------------------------------
// Event streams
// ---------------------------------------------------------------------------

/** Incoming Telegram signals wrapped as reducer events for the state machine. */
const signalEvent$: Observable<SignalEvent> = telegramSignal$.pipe(
  map(createSignalEvent),
);

/**
 * Periodic cleanup ticks emitted at the interval defined in the application
 * configuration.
 */
const tick$: Observable<TickEvent> = interval(CONFIG.signalCleanupIntervalMs).pipe(
  map(createTickEvent),
);

/** Merged event stream that drives the state reducer with both signal and tick events. */
const events$: Observable<EngineEvent> = merge(signalEvent$, tick$);

// ---------------------------------------------------------------------------
// Reducer state shape
// ---------------------------------------------------------------------------

/**
 * Snapshot of the current signal deduplication state.
 *
 * Consumers should treat all fields as **read-only**.  The reducer produces
 * a brand-new object on every emission to ensure immutability.
 */
export interface SignalState {
  /**
   * LP address → first-seen Unix timestamp (seconds).
   * Only contains pairs that are still within the TTL window.
   */
  readonly activeSignals: ActiveSignalMap;

  /** Signal accepted in the current reducer cycle, if any. Undefined when suppressed. */
  readonly accepted?: ParsedSignal;

  /** LP addresses that were evicted from the cache during cleanup in this cycle. */
  readonly expired: readonly string[];
}

// ---------------------------------------------------------------------------
// Reducer logic
// ---------------------------------------------------------------------------

/** Initial (empty) state before any events have been processed. */
const INITIAL_SIGNAL_STATE: SignalState = {
  activeSignals: new Map(),
  expired: [],
};

/**
 * Remove entries from the active-signal map whose age exceeds the configured
 * TTL (CONFIG.signalCacheTtlSeconds).
 *
 * Entries older than the TTL are moved to the `expired` list. The remaining
 * entries are returned in a new Map for immutability.
 *
 * @param active - The current map of active (LP → timestamp) entries.
 * @param now - The current Unix timestamp in seconds.
 * @returns An object containing the filtered active map and the list of
 *          expired LP addresses.
 */
const cleanupExpiredSignals = (
  active: ActiveSignalMap,
  now: number,
): { active: ActiveSignalMap; expired: readonly string[] } => {
  /** Create a fresh map for entries that are still within the TTL window */
  const remaining: ActiveSignalMap = new Map();
  /** Collect LP addresses that have exceeded the TTL */
  const expired: string[] = [];

  /** Iterate over every entry in the current active map */
  for (const [lp, ts] of active) {
    /** If the age (now - ts) exceeds the TTL, the entry is stale */
    if (now - ts > CONFIG.signalCacheTtlSeconds) {
      expired.push(lp);
    } else {
      /** Otherwise, retain the entry in the new map */
      remaining.set(lp, ts);
    }
  }

  return { active: remaining, expired };
};

/**
 * Core reducer — a pure function that produces the next SignalState from the
 * current state and an incoming event.
 *
 * The reducer follows these steps in every cycle:
 * 1. Evict stale entries from the active-signal cache.
 * 2. If the event is a tick → return the cleaned state with no accepted signal.
 * 3. If the event is a signal → check if the LP address is already known.
 *    - If known → suppress the duplicate (accepted = undefined).
 *    - If new → accept the signal, record the LP with the current timestamp.
 *
 * @param state - The current SignalState before processing the event.
 * @param event - The incoming event (signal or tick) to process.
 * @returns The next SignalState after applying the event.
 */
const reduceSignalState = (
  state: SignalState,
  event: EngineEvent,
): SignalState => {
  /** Use the event's timestamp to ensure consistency within a single cycle */
  const now = event.now;

  /** Step 1: Remove entries that have exceeded the TTL */
  const { active, expired } = cleanupExpiredSignals(state.activeSignals, now);

  /** Step 2: For tick events, there is no new signal — return the cleaned state */
  if (event.type === "tick") {
    return { activeSignals: active, accepted: undefined, expired };
  }

  /** Step 3: For signal events, deduplicate by LP address */
  const { signal } = event;

  /** If the LP address is already in the active map, suppress this duplicate */
  if (active.has(signal.lpAddress)) {
    return { activeSignals: active, accepted: undefined, expired };
  }

  /** The LP address is new — record it and accept the signal */
  active.set(signal.lpAddress, now);
  /** Log the acceptance for observability */
  console.log(`[ACCEPTED] ${signal.tokenName}`);

  /** Return the updated state with the accepted signal */
  return { activeSignals: active, accepted: signal, expired };
};

// ---------------------------------------------------------------------------
// Public streams
// ---------------------------------------------------------------------------

/**
 * Synchronous snapshot of the latest reducer state.
 * Used externally (e.g., WebSocket re-subscribe on reconnect) to retrieve the
 * current set of active signals without waiting for a new emission.
 */
export let latestSignalState: SignalState = INITIAL_SIGNAL_STATE;

/**
 * State stream: runs every incoming {@link EngineEvent} through the reducer
 * and caches the latest result so late subscribers receive the current state
 * immediately (via shareReplay with bufferSize: 1).
 */
export const signalState$: Observable<SignalState> = events$.pipe(
  scan<EngineEvent, SignalState>(reduceSignalState, INITIAL_SIGNAL_STATE),
  shareReplay<SignalState>({ bufferSize: 1, refCount: false }),
);

/** Subscribe to keep the `latestSignalState` variable synchronised with the stream. */
signalState$.subscribe((next) => {
  latestSignalState = next;
});

/**
 * Stream of newly accepted (deduplicated) signals.
 * Emits only when a non-duplicate signal passes the reducer and is marked
 * as `accepted` in the resulting state.
 */
export const acceptedSignal$: Observable<ParsedSignal> = signalState$.pipe(
  /** Type guard: filter to states that have an accepted signal */
  filter(
    (state): state is SignalState & { accepted: ParsedSignal } =>
      state.accepted !== undefined,
  ),
  /** Extract the accepted signal payload from the filtered state */
  map((state) => state.accepted),
);

/**
 * Stream of LP addresses that were evicted from the dedup cache.
 * Emits only when at least one pair has expired during the current cycle.
 */
export const expiredPair$: Observable<readonly string[]> = signalState$.pipe(
  /** Only emit when there are expired entries */
  filter((state) => state.expired.length > 0),
  /** Extract the array of expired LP addresses */
  map((state) => state.expired),
);
