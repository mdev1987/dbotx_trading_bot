/* ============================================================
 * telegram_listener.ts
 *
 * Reactive Telegram listener using:
 *
 * - teleproto (MTProto client)
 * - RxJS
 * - remove-markdown
 *
 * Responsibilities:
 *
 * - Login to Telegram
 * - Persist session
 * - Listen to new channel messages (AVE Scanner + Signal Monitor)
 * - Remove markdown formatting
 * - Parse AVE scanner messages
 * - Parse Ave Signal Monitor messages (signals + pump results)
 * - Emit parsed signals as RxJS streams
 *
 * ============================================================
 */

import readLine from "readline";
import removeMarkdown from "remove-markdown";

import { TelegramClient } from "teleproto";
import { StoreSession } from "teleproto/sessions";
import { NewMessage, NewMessageEvent } from "teleproto/events";

import { Observable, Subject, merge } from "rxjs";

import { filter, map, share } from "rxjs/operators";

import { CONFIG } from "../config";

import {
  parseSolanaPoolSignal,
  type SolanaPoolSignal,
} from "./ave_scanner_parser";

import {
  parseSignalMonitorSignal,
  parseSignalMonitorPump,
  type AveSignalMonitorPump,
} from "./ave_signal_monitor_parser";

/* ============================================================
 * Config validation
 * ============================================================
 */

const {
  telegramApiHash,
  telegramApiId,
  telegramChannelUserName,
  telegramChannelId,
  telegramSignalMonitorUserName,
} = CONFIG;

if (!telegramApiId || !telegramApiHash || !telegramChannelUserName) {
  throw new Error(
    "telegramApiId, telegramApiHash and telegramChannelUserName are required",
  );
}

/* ============================================================
 * Telegram session
 * ============================================================
 */

const session = new StoreSession("telegram_session");

export const telegramClient = new TelegramClient(
  session,
  Number(telegramApiId),
  telegramApiHash,
  {
    connectionRetries: 5,
    autoReconnect: true,
    reconnectRetries: Infinity,
    retryDelay: 5_000,
  },
);

/* ============================================================
 * Login prompt
 * ============================================================
 */

const rl = readLine.createInterface({
  input: process.stdin,
  output: process.stdout,
});

/**
 * Prompt the user for input with a 5-minute timeout.
 *
 * Rejects if the user does not respond in time, preventing
 * the process from hanging indefinitely.
 */
function ask(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      rl.removeAllListeners("line");

      reject(new Error("Input timed out after 5 minutes"));
    }, 5 * 60 * 1_000);

    rl.question(question, (answer) => {
      clearTimeout(timeout);

      resolve(answer);
    });
  });
}

/* ============================================================
 * Raw telegram message stream
 * ============================================================
 *
 * Every telegram message enters the system here.
 *
 * ============================================================
 */

const telegramMessageInput$ = new Subject<NewMessageEvent>();

export const telegramMessage$ = telegramMessageInput$.pipe(share());

/* ============================================================
 * Raw text stream
 * ============================================================
 */

export const telegramText$ = telegramMessage$.pipe(
  map((event) => event.message?.text ?? ""),
  filter((text) => text.trim().length > 0),
  share(),
);

/* ============================================================
 * Markdown removed stream
 * ============================================================
 */

export const cleanedTelegramText$ = telegramText$.pipe(
  map((text) => removeMarkdown(text)),
  share(),
);

/* ============================================================
 * Parsed AVE signal stream
 * ============================================================
 */

const aveSignal$ = cleanedTelegramText$.pipe(
  map((text) => {
    try {
      return parseSolanaPoolSignal(text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== "Failed to parse pair") {
        console.warn("[Telegram] Skip non-signal message:", msg);
      }
      return null;
    }
  }),
  filter((s): s is SolanaPoolSignal => s !== null),
);

/* ============================================================
 * Parsed Signal Monitor stream
 * ============================================================
 */

const signalMonitorSignalConverted$ = cleanedTelegramText$.pipe(
  map((text) => {
    const r = parseSignalMonitorSignal(text);
    if (!r) return null;

    return {
      tokenName: r.tokenName,
      contractAddress: r.contractAddress,
      lpAddress: r.contractAddress,
      dex: "pump.fun",
      maxPumpX: r.maxPumpX,
      marketCapRaw: "",
      marketCapUsd: r.marketCapUsd,
      raw: r.raw,
    } as SolanaPoolSignal;
  }),
  filter((s): s is SolanaPoolSignal => s !== null),
);

const signalMonitorPumpInput$ = new Subject<AveSignalMonitorPump>();

/** Emits when a pump-result message arrives from @AveSignalMonitor. */
export const signalMonitorPump$ = signalMonitorPumpInput$.pipe(share());

/* Merge AVE signals + Signal Monitor signals into one stream. */
export const signal$ = merge(aveSignal$, signalMonitorSignalConverted$).pipe(
  share(),
);

/* Parse pump results from cleaned text and feed the subject. */
cleanedTelegramText$
  .pipe(
    map((text) => parseSignalMonitorPump(text)),
    filter((r): r is AveSignalMonitorPump => r !== null),
  )
  .subscribe((pump) => signalMonitorPumpInput$.next(pump));

/* ============================================================
 * Connection state stream
 * ============================================================
 */

const connectedInput$ = new Subject<boolean>();

export const connected$ = connectedInput$.pipe(share());

/* ============================================================
 * Start listener
 * ============================================================
 */

let channelIds: number[] = [];

export async function startTelegramListener(): Promise<void> {
  try {
    await telegramClient.start({
      phoneNumber: async () => ask("Phone number: "),

      phoneCode: async () => ask("Telegram code: "),

      password: async () => ask("2FA password: "),

      onError: console.error,
    });

    /*
     * Save session for both StoreSession
     * and MemorySession compatibility.
     */
    telegramClient.session.save();

    rl.close();

    connectedInput$.next(true);

    console.log("[Telegram] Client connected");
  } catch (err) {
    rl.close();
    console.error("[Telegram] Login failed:", err);
    throw err;
  }

  /* Resolve channel IDs. */
  const ids: number[] = [];

  try {
    const ch1 = await telegramClient.getEntity(telegramChannelUserName!);
    ids.push(Number(ch1.id));
    console.log(`[Telegram] Resolved ${telegramChannelUserName} → ${ch1.id}`);
  } catch (err) {
    console.error(
      `[Telegram] Failed to resolve channel "${telegramChannelUserName}":`,
      err,
    );
    throw err;
  }

  if (telegramSignalMonitorUserName) {
    try {
      const ch2 = await telegramClient.getEntity(telegramSignalMonitorUserName);
      ids.push(Number(ch2.id));
      console.log(
        `[Telegram] Resolved ${telegramSignalMonitorUserName} → ${ch2.id}`,
      );
    } catch (err) {
      console.error(
        `[Telegram] Failed to resolve channel "${telegramSignalMonitorUserName}":`,
        err,
      );
    }
  }

  if (telegramChannelId && !ids.includes(Number(telegramChannelId))) {
    ids.push(Number(telegramChannelId));
  }

  channelIds = ids;

  console.log(`[Telegram] Listening to ${ids.length} channel(s): ${ids.join(", ")}`);

  telegramClient.addEventHandler(
    (event: NewMessageEvent) => {
      telegramMessageInput$.next(event);
    },

    new NewMessage({
      incoming: true,
      chats: ids,
    }),
  );
}

/* ============================================================
 * Stop listener
 * ============================================================
 */

export async function stopTelegramListener(): Promise<void> {
  connectedInput$.next(false);

  telegramMessageInput$.complete();
  connectedInput$.complete();
  signalMonitorPumpInput$.complete();

  await telegramClient.disconnect();

  console.log("[Telegram] Client disconnected");
}
