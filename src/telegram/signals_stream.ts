import { Subject, Observable, interval, merge } from "rxjs";
import { filter, map, scan, shareReplay } from "rxjs/operators";
import { signal$ as telegramSignal$ } from "./telegram_listener";
import { CONFIG } from "../config";
import type { SolanaPoolSignal } from "./ave_scanner_parser";

/* ============================================================
 * Configuration
 * ============================================================
 */

const TTL_SECONDS = CONFIG.ttlSignalSeconds;
const MAX_POSITIONS = CONFIG.maxPositions;

/* ============================================================
 * Internal event types
 * ============================================================
 */

interface SignalEvent {
  type: "signal";
  signal: SolanaPoolSignal;
  now: number;
}

interface TickEvent {
  type: "tick";
  now: number;
}

type EngineEvent = SignalEvent | TickEvent;

/* ============================================================
 * Internal engine streams
 * ============================================================
 */

const signalEvent$ = telegramSignal$.pipe(
  map<SolanaPoolSignal, SignalEvent>((signal) => ({
    type: "signal",
    signal,
    now: Math.floor(Date.now() / 1000),
  })),
);

const tick$ = interval(5_000).pipe(
  map<number, TickEvent>(() => ({
    type: "tick",
    now: Math.floor(Date.now() / 1000),
  })),
);

const events$: Observable<EngineEvent> = merge(signalEvent$, tick$);

/* ============================================================
 * State
 * ============================================================
 */

export interface SignalState {
  /*
   * Active LP addresses.
   *
   * key   -> LP address
   * value -> expiration timestamp in seconds
   */
  active: Map<string, number>;

  /*
   * Newly accepted signal.
   */
  accepted?: SolanaPoolSignal;

  /*
   * LP addresses removed during this reducer cycle.
   *
   * Can happen because of:
   *
   * - TTL expiration
   * - FIFO eviction
   */
  expired: string[];
}

/* ============================================================
 * Main reducer
 * ============================================================
 */

/**
 * Latest signal state snapshot, updated synchronously inside the scan
 * reducer.  Exported so that other modules (e.g. dbotx_data_ws) can
 * read the current active pairs without creating a new subscription
 * that would restart the scan from scratch.
 */
export let latestSignalState: SignalState = { active: new Map(), expired: [] };

export const signalState$ = events$.pipe(
  scan<EngineEvent, SignalState>(
    (state, event) => {
      const now = event.now;

      const active = new Map(state.active);

      const expired: string[] = [];

      for (const [lp, expiresAt] of active) {
        if (expiresAt <= now) {
          active.delete(lp);
          expired.push(lp);
          console.log(`[TTL] Removed ${lp}`);
        }
      }

      if (event.type === "tick") {
        latestSignalState = { active, accepted: undefined, expired };
        return latestSignalState;
      }

      const signal = event.signal;

      if (active.has(signal.lpAddress)) {



        latestSignalState = { active, accepted: undefined, expired };
        return latestSignalState;
      }

      if (active.size >= MAX_POSITIONS) {
        const oldest = active.keys().next().value;
        if (oldest) {
          active.delete(oldest);
          expired.push(oldest);
          console.log(`[FIFO] Removed ${oldest}`);
        }
      }

      active.set(signal.lpAddress, now + TTL_SECONDS);
      console.log(`[ACCEPTED] ${signal.tokenName}`);

      latestSignalState = { active, accepted: signal, expired };
      return latestSignalState;
    },
    { active: new Map<string, number>(), expired: [] },
  ),

  shareReplay({ bufferSize: 1, refCount: false }),
);

/* ============================================================
 * Accepted signals
 * ============================================================
 */

export const acceptedSignal$ = signalState$.pipe(
  filter(
    (
      state,
    ): state is SignalState & {
      accepted: SolanaPoolSignal;
    } => state.accepted !== undefined,
  ),

  map((state) => state.accepted),
);

/* ============================================================
 * Expired LP addresses
 * ============================================================
 */

export const expiredPair$ = signalState$.pipe(
  filter((state) => state.expired.length > 0),

  map((state) => state.expired),
);
