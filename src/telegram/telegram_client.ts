import readline from "readline";
import removeMarkdown from "remove-markdown";

import { TelegramClient } from "teleproto";
import { StoreSession } from "teleproto/sessions";
import { NewMessage, NewMessageEvent } from "teleproto/events";

import {
  BehaviorSubject,
  Observable,
  ReplaySubject,
  Subject,
  merge,
  timer,
} from "rxjs";

import {
  distinctUntilChanged,
  filter,
  map,
  scan,
  shareReplay,
  withLatestFrom,
} from "rxjs/operators";

import { CONFIG } from "../config";
import {
  parseAveScannerSignal,
  type AveScannerSignal,
} from "./ave_scanner_parser";

/* -------------------------------------------------------------------------- */
/*                           Configuration Validation                         */
/* -------------------------------------------------------------------------- */

if (
  !CONFIG.telegramApiId ||
  !CONFIG.telegramApiHash ||
  !CONFIG.telegramChannelUserName
) {
  throw new Error(
    "Missing Telegram configuration. " +
      "telegramApiId, telegramApiHash and telegramChannelUserName are required.",
  );
}

/* -------------------------------------------------------------------------- */
/*                           Telegram Client Singleton                        */
/* -------------------------------------------------------------------------- */

/**
 * Lazily-created Telegram client.
 *
 * A singleton avoids opening multiple MTProto connections
 * and keeps authentication/session handling centralized.
 */
let telegramClient: TelegramClient | undefined;

/**
 * Returns the shared Telegram client instance.
 *
 * The client is created only once and reused throughout the
 * application's lifetime.
 */
export function getTelegramClient(): TelegramClient {
  if (telegramClient) {
    return telegramClient;
  }

  telegramClient = new TelegramClient(
    new StoreSession("telegram_session"),
    Number(CONFIG.telegramApiId),
    CONFIG.telegramApiHash!,
    {
      connectionRetries: CONFIG.tgConnectionRetries,

      autoReconnect: true,

      reconnectRetries: Infinity,

      retryDelay: CONFIG.tgRetryDelayMs,
    },
  );

  return telegramClient;
}

/**
 * Destroys the singleton reference.
 *
 * Mainly used by tests to force creation of a fresh client.
 */
export function resetTelegramClient(): void {
  telegramClient = undefined;
}

/* -------------------------------------------------------------------------- */
/*                              Console Helpers                               */
/* -------------------------------------------------------------------------- */

/**
 * Creates a temporary readline interface.
 *
 * A new interface is created for every authentication flow
 * and immediately disposed afterwards.
 */
function createReadline() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

/**
 * Prompts the user for console input.
 *
 * Automatically times out if the user does not respond within
 * the configured authentication timeout.
 *
 * @param question Prompt displayed in the terminal.
 * @returns User input.
 */
async function ask(question: string): Promise<string> {
  const rl = createReadline();

  return new Promise((resolve, reject) => {
    let completed = false;

    const timeout = setTimeout(() => {
      if (completed) return;

      completed = true;

      rl.close();

      reject(
        new Error(
          `Input timed out after ${CONFIG.tgAuthTimeoutMs / 1000} seconds.`,
        ),
      );
    }, CONFIG.tgAuthTimeoutMs);

    rl.question(question, (answer) => {
      if (completed) return;

      completed = true;

      clearTimeout(timeout);

      rl.close();

      resolve(answer.trim());
    });
  });
}

/* -------------------------------------------------------------------------- */
/*                           Telegram Message Stream                          */
/* -------------------------------------------------------------------------- */

/**
 * Raw Telegram message stream.
 *
 * Every incoming Telegram message is pushed into this subject by the
 * Telegram event handler. It is intentionally kept private so the rest
 * of the application only consumes parsed signals.
 */
const telegramMessageInput$ = new Subject<NewMessageEvent>();

/* -------------------------------------------------------------------------- */
/*                           Connection State Stream                          */
/* -------------------------------------------------------------------------- */

/**
 * Current Telegram connection state.
 *
 * New subscribers immediately receive the latest connection status.
 */
const connectionStateInput$ = new BehaviorSubject<boolean>(false);

/**
 * Emits:
 *
 * true  -> Connected
 * false -> Disconnected
 */
export const tgConnected$ = connectionStateInput$.pipe(
  distinctUntilChanged(),
  shareReplay({
    bufferSize: 1,
    refCount: true,
  }),
);

/* -------------------------------------------------------------------------- */
/*                           Signal Pause / Resume                            */
/* -------------------------------------------------------------------------- */

/**
 * Controls whether new Telegram signals should be processed.
 *
 * Pausing only stops new signals from entering the pipeline.
 * Existing positions and other background tasks continue running.
 */
const pausedInput$ = new BehaviorSubject<boolean>(false);

/**
 * Observable pause state.
 */
export const signalPaused$ = pausedInput$.pipe(
  distinctUntilChanged(),
  shareReplay({
    bufferSize: 1,
    refCount: true,
  }),
);

/* -------------------------------------------------------------------------- */
/*                           Parsed Telegram Signals                          */
/* -------------------------------------------------------------------------- */

/**
 * Main stream consumed by the trading engine.
 *
 * Pipeline:
 *
 * Telegram Message
 *        ↓
 * Markdown Removal
 *        ↓
 * Ave Parser
 *        ↓
 * Normalization
 *        ↓
 * Pause Filter
 *        ↓
 * ParsedSignal
 */
export const telegramSignal$: Observable<AveScannerSignal> =
  telegramMessageInput$.pipe(
    /**
     * Extract message text.
     */
    map((event) => (event.message?.text ?? "").trim()),

    /**
     * Ignore empty messages.
     */
    filter((text) => text.length > 0),

    /**
     * Telegram formatting is irrelevant for parsing.
     */
    map((text) => removeMarkdown(text)),

    /**
     * Parse Ave Scanner message.
     */
    map((raw) => parseAveScannerSignal(raw)),

    /**
     * Ignore messages that are not Ave Scanner signals.
     */
    filter((parsed: AveScannerSignal | null) => parsed !== null),

    /**
     * Stop signals while paused.
     */
    withLatestFrom(signalPaused$),

    filter(([_, paused]) => !paused),

    map(([signal]) => signal),

    /**
     * Cache the latest parsed signal.
     */
    shareReplay({
      bufferSize: 1,
      refCount: true,
    }),
  );

/* -------------------------------------------------------------------------- */
/*                          Telegram Event Registration                       */
/* -------------------------------------------------------------------------- */

/**
 * Telegram channel ID.
 *
 * If not explicitly configured, it will be resolved from the channel
 * username during startup.
 */
let telegramChannelId: number | undefined = CONFIG.telegramChannelId
  ? Number(CONFIG.telegramChannelId)
  : undefined;

/**
 * Current Telegram event handler.
 *
 * Stored so it can be removed when reconnecting or shutting down.
 */
let telegramEventHandler: ((event: NewMessageEvent) => void) | undefined;

/**
 * Current Telegram event builder.
 */
let telegramEventBuilder: NewMessage | undefined;

/* -------------------------------------------------------------------------- */
/*                          Telegram Listener Start                           */
/* -------------------------------------------------------------------------- */

/**
 * Starts the Telegram listener.
 *
 * Workflow:
 *
 * 1. Connect to Telegram.
 * 2. Authenticate (first run only).
 * 3. Resolve channel ID if necessary.
 * 4. Register message event handler.
 * 5. Publish connection state.
 */
export async function startTelegramListener(): Promise<void> {
  const client = getTelegramClient();

  try {
    console.log("[Telegram] Connecting...");

    await client.start({
      phoneNumber: () => ask("Phone number: "),
      phoneCode: () => ask("Telegram code: "),

      onError(error) {
        console.error("[Telegram]", error);
      },
    });

    // Persist login session.
    client.session.save();

    connectionStateInput$.next(true);

    console.log("[Telegram] Connected");

    /* ---------------------------------------------------------------------- */
    /* Resolve Telegram channel ID                                            */
    /* ---------------------------------------------------------------------- */

    if (!telegramChannelId) {
      const entity = await client.getEntity(CONFIG.telegramChannelUserName);

      telegramChannelId = Number(entity.id);
    }

    console.log(
      `[Telegram] Listening to ${CONFIG.telegramChannelUserName} (${telegramChannelId})`,
    );

    /* ---------------------------------------------------------------------- */
    /* Remove previous event handler                                          */
    /* ---------------------------------------------------------------------- */

    if (telegramEventHandler && telegramEventBuilder) {
      try {
        client.removeEventHandler(telegramEventHandler, telegramEventBuilder);
      } catch {
        // Ignore if already removed.
      }
    }

    /* ---------------------------------------------------------------------- */
    /* Register new event handler                                             */
    /* ---------------------------------------------------------------------- */

    telegramEventHandler = (event) => {
      telegramMessageInput$.next(event);
    };

    telegramEventBuilder = new NewMessage({
      incoming: true,
      chats: [telegramChannelId],
    });

    client.addEventHandler(telegramEventHandler, telegramEventBuilder);

    console.log("[Telegram] Listener started");
  } catch (error) {
    connectionStateInput$.next(false);

    console.error("[Telegram] Failed to start listener:", error);

    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/*                           Telegram Listener Stop                           */
/* -------------------------------------------------------------------------- */

/**
 * Stops listening for Telegram messages and disconnects
 * from the Telegram network.
 */
export async function stopTelegramListener(): Promise<void> {
  const client = getTelegramClient();

  try {
    if (telegramEventHandler && telegramEventBuilder) {
      try {
        client.removeEventHandler(telegramEventHandler, telegramEventBuilder);
      } catch {
        // Ignore removal errors.
      }
    }

    telegramEventHandler = undefined;
    telegramEventBuilder = undefined;

    await client.disconnect();

    console.log("[Telegram] Disconnected");
  } finally {
    connectionStateInput$.next(false);
  }
}

/* -------------------------------------------------------------------------- */
/*                         Signal Deduplication Engine                         */
/* -------------------------------------------------------------------------- */

/**
 * Internal state maintained by the deduplication engine.
 *
 * activeSignals
 *      LP Address -> First Seen Timestamp (ms)
 *
 * accepted
 *      Newly accepted signal for this update.
 *
 * expired
 *      LP addresses removed because their TTL expired.
 */
interface SignalState {
  activeSignals: Map<string, number>;

  accepted?: AveScannerSignal;

  expired: string[];
}

/**
 * Initial state.
 */
const INITIAL_SIGNAL_STATE: SignalState = {
  activeSignals: new Map(),
  expired: [],
};

/* -------------------------------------------------------------------------- */
/*                              Internal Events                               */
/* -------------------------------------------------------------------------- */

type SignalEvent =
  | {
      type: "signal";
      signal: AveScannerSignal;
      now: number;
    }
  | {
      type: "tick";
      now: number;
    };

/**
 * Emits whenever a new trading signal arrives.
 */
const signalEvent$ = telegramSignal$.pipe(
  map(
    (signal): SignalEvent => ({
      type: "signal",
      signal,
      now: Date.now(),
    }),
  ),
);

/**
 * Periodic cleanup timer.
 *
 * Responsible for removing expired LP addresses from the
 * deduplication cache.
 */
const cleanupTick$ = timer(
  CONFIG.signalCleanupIntervalMs,
  CONFIG.signalCleanupIntervalMs,
).pipe(
  map(
    (): SignalEvent => ({
      type: "tick",
      now: Date.now(),
    }),
  ),
);

/* -------------------------------------------------------------------------- */
/*                             State Reducer                                  */
/* -------------------------------------------------------------------------- */

/**
 * Updates the deduplication state.
 *
 * Processing order:
 *
 * 1. Remove expired LPs.
 * 2. Accept cleanup tick.
 * 3. Ignore duplicate LPs.
 * 4. Accept new signal.
 */
function reduceSignalState(
  state: SignalState,
  event: SignalEvent,
): SignalState {
  const activeSignals = new Map<string, number>();

  const expired: string[] = [];

  /* ---------------------------------------------------------------------- */
  /* Remove expired entries                                                  */
  /* ---------------------------------------------------------------------- */

  for (const [lpAddress, timestamp] of state.activeSignals) {
    if (event.now - timestamp > CONFIG.signalCacheTtlSeconds * 1000) {
      expired.push(lpAddress);
      continue;
    }

    activeSignals.set(lpAddress, timestamp);
  }

  /* ---------------------------------------------------------------------- */
  /* Cleanup tick                                                            */
  /* ---------------------------------------------------------------------- */

  if (event.type === "tick") {
    return {
      activeSignals,
      expired,
      accepted: undefined,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Duplicate LP                                                            */
  /* ---------------------------------------------------------------------- */

  if (activeSignals.has(event.signal.LP!)) {
    return {
      activeSignals,
      expired,
      accepted: undefined,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Accept signal                                                           */
  /* ---------------------------------------------------------------------- */

  activeSignals.set(event.signal.LP!, event.now);

  console.log(`[Telegram] Accepted ${event.signal.Token!}`);

  return {
    activeSignals,
    expired,
    accepted: event.signal,
  };
}

/* -------------------------------------------------------------------------- */
/*                           Signal State Stream                              */
/* -------------------------------------------------------------------------- */

/**
 * Central deduplication state.
 *
 * Every signal and cleanup tick passes through the reducer.
 */
export const signalState$ = merge(signalEvent$, cleanupTick$).pipe(
  scan(reduceSignalState, INITIAL_SIGNAL_STATE),

  shareReplay({
    bufferSize: 1,
    refCount: false,
  }),
);

/**
 * Latest deduplication state.
 *
 * Useful for synchronous lookups.
 */
export let latestSignalState = INITIAL_SIGNAL_STATE;

signalState$.subscribe((state) => {
  latestSignalState = state;
});

/* -------------------------------------------------------------------------- */
/*                           Public Signal Streams                            */
/* -------------------------------------------------------------------------- */

/**
 * Emits only newly accepted signals.
 */
export const acceptedSignal$ = signalState$.pipe(
  filter((state) => state.accepted !== undefined),

  map((state) => state.accepted!),
);

/**
 * Emits LP addresses removed from the cache.
 */
export const expiredPair$ = signalState$.pipe(
  filter((state) => state.expired.length > 0),

  map((state) => state.expired),
);

/* -------------------------------------------------------------------------- */
/*                           Signal Flow Control                              */
/* -------------------------------------------------------------------------- */

/**
 * Pauses processing of new Telegram signals.
 *
 * Incoming Telegram messages are still received from Telegram,
 * but they are filtered out before entering the trading pipeline.
 *
 * Existing positions, price feeds and execution engines are
 * unaffected.
 */
export function pauseSignals(): void {
  if (pausedInput$.value) {
    return;
  }

  pausedInput$.next(true);

  console.log("[Telegram] Signal processing paused");
}

/**
 * Resumes processing of Telegram signals.
 */
export function resumeSignals(): void {
  if (!pausedInput$.value) {
    return;
  }

  pausedInput$.next(false);

  console.log("[Telegram] Signal processing resumed");
}

/**
 * Returns the current pause state.
 */
export function isSignalPaused(): boolean {
  return pausedInput$.value;
}

/* -------------------------------------------------------------------------- */
/*                               Diagnostics                                  */
/* -------------------------------------------------------------------------- */

/**
 * Returns the number of active LP addresses currently stored in the
 * deduplication cache.
 */
export function getCachedSignalCount(): number {
  return latestSignalState.activeSignals.size;
}

/**
 * Returns true if the LP address is currently inside the dedupe cache.
 */
export function isSignalCached(lpAddress: string): boolean {
  return latestSignalState.activeSignals.has(lpAddress);
}

/**
 * Removes every cached LP address.
 *
 * Useful during testing or when restarting the trading engine
 * without reconnecting Telegram.
 */
export function clearSignalCache(): void {
  latestSignalState = {
    activeSignals: new Map(),
    expired: [],
  };

  console.log("[Telegram] Signal cache cleared");
}

/* -------------------------------------------------------------------------- */
/*                           Graceful Shutdown                                */
/* -------------------------------------------------------------------------- */

/**
 * Completely shuts down the Telegram module.
 *
 * Stops listening for Telegram messages,
 * disconnects from Telegram,
 * and clears all runtime state.
 */
export async function shutdownTelegram(): Promise<void> {
  try {
    await stopTelegramListener();
  } finally {
    clearSignalCache();

    pausedInput$.next(false);

    resetTelegramClient();
  }
}
