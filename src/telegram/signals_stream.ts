import { Subject, Observable, interval, merge } from "rxjs";
import { filter, map, scan, shareReplay } from "rxjs/operators";
import { signal$ as telegramSignal$ } from "./telegram_listener";
import type { SolanaPoolSignal } from "./ave_scanner_parser";

/** Hardcoded cleanup TTL for dedup cache (1 hour). */
const CLEANUP_TTL_SECONDS = 3600;

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

export interface SignalState {
  /** Active LP addresses keyed by LP → insertion timestamp (seconds). */
  active: Map<string, number>;
  /** Newly accepted signal emitted from the reducer. */
  accepted?: SolanaPoolSignal;
  /** LP addresses removed during this reducer cycle (cleanup). */
  expired: string[];
}

export let latestSignalState: SignalState = { active: new Map(), expired: [] };

export const signalState$ = events$.pipe(
  scan<EngineEvent, SignalState>(
    (state, event) => {
      const now = event.now;
      const active = new Map(state.active);
      const expired: string[] = [];

      /* Cleanup: remove entries older than CLEANUP_TTL_SECONDS to
         prevent unbounded memory growth. */
      for (const [lp, ts] of active) {
        if (now - ts > CLEANUP_TTL_SECONDS) {
          active.delete(lp);
          expired.push(lp);
        }
      }

      if (event.type === "tick") {
        latestSignalState = { active, accepted: undefined, expired };
        return latestSignalState;
      }

      const signal = event.signal;

      /* Dedup: skip if already seen. */
      if (active.has(signal.lpAddress)) {
        latestSignalState = { active, accepted: undefined, expired };
        return latestSignalState;
      }

      active.set(signal.lpAddress, now);
      console.log(`[ACCEPTED] ${signal.tokenName}`);

      latestSignalState = { active, accepted: signal, expired };
      return latestSignalState;
    },
    { active: new Map<string, number>(), expired: [] },
  ),
  shareReplay({ bufferSize: 1, refCount: false }),
);

export const acceptedSignal$ = signalState$.pipe(
  filter(
    (state): state is SignalState & { accepted: SolanaPoolSignal } =>
      state.accepted !== undefined,
  ),
  map((state) => state.accepted),
);

export const expiredPair$ = signalState$.pipe(
  filter((state) => state.expired.length > 0),
  map((state) => state.expired),
);
