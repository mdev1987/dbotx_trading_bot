/* ============================================================
 * telegram_listener.ts
 *
 * Reactive Telegram listener using:
 *
 * - gramjs
 * - RxJS
 * - remove-markdown
 *
 * Responsibilities:
 *
 * - Login to Telegram
 * - Persist session
 * - Listen to new channel messages
 * - Remove markdown formatting
 * - Parse AVE scanner messages
 * - Emit parsed signals as RxJS streams
 *
 * ============================================================
 */

import readLine from "readline";
import removeMarkdown from "remove-markdown";

import { TelegramClient } from "telegram";
import { StoreSession } from "telegram/sessions";
import { NewMessage, NewMessageEvent } from "telegram/events";

import { Observable, Subject, from, EMPTY } from "rxjs";

import { filter, map, share, tap, catchError } from "rxjs/operators";

import { CONFIG } from "../config";

import {
  parseSolanaPoolSignal,
  type SolanaPoolSignal,
} from "./ave_scanner_parser";

/* ============================================================
 * Config validation
 * ============================================================
 */

const {
  telegramApiHash,
  telegramApiId,
  telegramChannelUserName,
  telegramChannelId,
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
    //autoReconnect: true,
    //reconnectRetries: 5, default infinity
    //retryDelay: 1000,
    //requestRetries: 5,
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

export const signal$ = cleanedTelegramText$.pipe(
  map((text) => parseSolanaPoolSignal(text)),

  tap((signal) => {
    console.log(`[SIGNAL] ${signal.tokenName} (${signal.lpAddress})`);
  }),

  catchError((error) => {
    console.error("[Telegram] Failed to parse signal:", error);

    return EMPTY;
  }),

  share(),
);

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
let channelId: number = Number(telegramChannelId ?? undefined);
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

  if (!channelId) {
    try {
      const channel = await telegramClient.getEntity(telegramChannelUserName!);
      channelId = Number(channel.id);
    } catch (err) {
      console.error(
        `[Telegram] Failed to resolve channel "${telegramChannelUserName}":`,
        err,
      );
      throw err;
    }
  }

  console.log(`[Telegram] Listening to ${telegramChannelUserName} (${channelId})`);

  telegramClient.addEventHandler(
    (event: NewMessageEvent) => {
      telegramMessageInput$.next(event);
    },

    new NewMessage({
      incoming: true,
      chats: [channelId],
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

  await telegramClient.disconnect();

  console.log("[Telegram] Client disconnected");
}
