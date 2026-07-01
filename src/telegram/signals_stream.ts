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

export const signalState$ = events$.pipe(
  scan<EngineEvent, SignalState>(
    (state, event) => {
      const now = event.now;

      const expired: string[] = [];

      /*
       * ------------------------------------------
       * TTL cleanup
       * ------------------------------------------
       */

      for (const [lp, expiresAt] of state.active) {
        if (expiresAt <= now) {
          state.active.delete(lp);

          expired.push(lp);

          console.log(`[TTL] Removed ${lp}`);
        }
      }

      /*
       * Tick events only perform cleanup.
       */

      if (event.type === "tick") {
        return {
          ...state,
          accepted: undefined,
          expired,
        };
      }

      const signal = event.signal;

      /*
       * ------------------------------------------
       * Dedup
       * ------------------------------------------
       */

      if (state.active.has(signal.lpAddress)) {
        console.log(`[DEDUP] ${signal.tokenName}`);

        return {
          ...state,
          accepted: undefined,
          expired,
        };
      }

      /*
       * ------------------------------------------
       * FIFO eviction
       * ------------------------------------------
       */

      if (state.active.size >= MAX_POSITIONS) {
        const oldest = state.active.keys().next().value;

        if (oldest) {
          state.active.delete(oldest);

          expired.push(oldest);

          console.log(`[FIFO] Removed ${oldest}`);
        }
      }

      /*
       * ------------------------------------------
       * Accept signal
       * ------------------------------------------
       */

      state.active.set(signal.lpAddress, now + TTL_SECONDS);

      console.log(`[ACCEPTED] ${signal.tokenName}`);

      return {
        active: state.active,
        accepted: signal,
        expired,
      };
    },
    {
      active: new Map<string, number>(),
      expired: [],
    },
  ),

  shareReplay({
    bufferSize: 1,
    refCount: true,
  }),
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
