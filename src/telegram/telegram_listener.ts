// Reactive Telegram listener using MTProto (teleproto) + RxJS.
//
// Responsibilities:
// - Authenticate with Telegram.
// - Subscribe to a single Telegram channel.
// - Convert MTProto events into reactive RxJS streams.
// - Parse channel messages into strongly typed trading signals.
// - Expose connection status and signal streams.
//
// This module is designed for long-running trading bots and supports
// graceful restart without process termination.

import readline from "readline";
import removeMarkdown from "remove-markdown";

import { TelegramClient } from "teleproto";
import { StoreSession } from "teleproto/sessions";
import { NewMessage, NewMessageEvent } from "teleproto/events";

import { ReplaySubject, Subject } from "rxjs";

import { distinctUntilChanged, filter, map, shareReplay } from "rxjs/operators";

import { CONFIG } from "../config";

import {
  parseAveScannerSignal,
  type AveScannerSignal,
} from "./ave_scanner_parser";

import {
  parseSignalMonitorMessage,
  type AveSignalMonitorPump,
  type AveSignalMonitorSignal,
} from "./ave_signal_monitor_parser";

/* -------------------------------------------------------------------------- */
/*                                  Constants                                 */
/* -------------------------------------------------------------------------- */



const CHANNEL_NAME = CONFIG.telegramChannelUserName.toLowerCase();

/* -------------------------------------------------------------------------- */
/*                               Configuration                                */
/* -------------------------------------------------------------------------- */

if (
  !CONFIG.telegramApiId ||
  !CONFIG.telegramApiHash ||
  !CONFIG.telegramChannelUserName
) {
  throw new Error(
    "telegramApiId, telegramApiHash and telegramChannelUserName are required",
  );
}

/* -------------------------------------------------------------------------- */
/*                             Telegram Session                               */
/* -------------------------------------------------------------------------- */

// Persistent Telegram authentication session stored to disk
const session = new StoreSession("telegram_session");

// Telegram MTProto client configured with auto-reconnect and retry settings
export const telegramClient = new TelegramClient(
  session,
  Number(CONFIG.telegramApiId),
  CONFIG.telegramApiHash,
  {
    connectionRetries: CONFIG.tgConnectionRetries,
    autoReconnect: true,
    reconnectRetries: Infinity,
    retryDelay: CONFIG.tgRetryDelayMs,
  },
);

/* -------------------------------------------------------------------------- */
/*                               CLI Helpers                                  */
/* -------------------------------------------------------------------------- */

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

/**
 * Prompt the user for input during Telegram authentication.
 *
 * A timeout protects against hanging CI environments or unattended terminals.
 *
 * @param question - Prompt text shown to the user.
 * @returns User input trimmed of whitespace.
 * @throws {Error} If the user does not respond within CONFIG.tgAuthTimeoutMs.
 */
async function ask(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Guard against double-resolution (race between timeout and user answer)
    let completed = false;

    // Schedule a timeout that rejects if the user doesn't respond in time
    const timeout = setTimeout(() => {
      if (completed) return;

      completed = true;

      // Timeout reached — reject the promise with a descriptive error
      reject(
        new Error(`Input timed out after ${CONFIG.tgAuthTimeoutMs / 1000} seconds`),
      );
    }, CONFIG.tgAuthTimeoutMs);

    // Listen for user input from stdin via readline
    rl.question(question, (answer) => {
      // Ignore if already completed (race between timeout and answer)
      if (completed) return;

      completed = true;
      clearTimeout(timeout);

      resolve(answer.trim());
    });
  });
}

/* -------------------------------------------------------------------------- */
/*                               Parser Setup                                 */
/* -------------------------------------------------------------------------- */

export type ParsedSignal =
  | AveSignalMonitorSignal
  | AveSignalMonitorPump
  | AveScannerSignal;

/**
 * Select the appropriate message parser based on the configured channel.
 *
 * Throws at module load time if the channel is not supported,
 * so invalid configurations are caught immediately on import.
 */
const parser = (() => {
  switch (CHANNEL_NAME) {
    // Ave Signal Monitor → parse pump-detection monitor messages
    case "avesignalmonitor":
      return parseSignalMonitorMessage;

    // Ave Solana Token Scanner → parse scanner trade signals
    case "avesolantokenscanner":
      return parseAveScannerSignal;

    // Unknown channel — fail fast at import time
    default:
      throw new Error(`Unsupported telegram channel parser: ${CHANNEL_NAME}`);
  }
})();

/* -------------------------------------------------------------------------- */
/*                             Reactive Streams                               */
/* -------------------------------------------------------------------------- */

/**
 * Raw Telegram MTProto events.
 */
const telegramMessageInput$ = new Subject<NewMessageEvent>();

/**
 * Emits parsed trading signals processed from raw Telegram messages.
 *
 * Pipeline:
 *   MTProto Event → extract text → trim → strip markdown → parse → filter nulls → share
 *
 * Deduplication (distinctUntilChanged by contractAddress) is commented out
 * because the parser layer already deduplicates for Ave Scanner.
 */
export const telegramSignal$ = telegramMessageInput$.pipe(
  // Step 1: Extract message text (default to empty string)
  map((event) => event.message?.text ?? ""),
  // Step 2: Trim whitespace
  map((text) => text.trim()),
  // Step 3: Skip empty messages
  filter((text) => text.length > 0),
  // Step 4: Strip Telegram MarkdownV2 formatting
  map((text) => removeMarkdown(text)),
  // Step 5: Parse the raw text into a structured signal
  map((text) => parser(text)),
  // Step 6: Filter out unparseable messages (parser returned null)
  filter((signal): signal is ParsedSignal => signal !== null),
  //Only compares with the immediately previous signal
  // For Ave Scanner Channel
  // distinctUntilChanged(
  //   (prev, curr) => prev.contractAddress === curr.contractAddress,
  // ),
  // Step 7: Cache the latest signal and share across subscribers
  shareReplay({
    bufferSize: 1,
    refCount: true,
  }),
);

/**
 * Connection state stream.
 */
const connectionStateInput$ = new ReplaySubject<boolean>(1);

/**
 * Emits `true` when connected to Telegram, `false` on disconnect.
 *
 * Replays the last known state so late subscribers always get the current status.
 */
export const connected$ = connectionStateInput$.pipe(
  shareReplay({
    bufferSize: 1,
    refCount: true,
  }),
);

/* -------------------------------------------------------------------------- */
/*                              Internal State                                */
/* -------------------------------------------------------------------------- */

let channelId: number | undefined = Number(CONFIG.telegramChannelId);

let eventHandler: ((event: NewMessageEvent) => void) | undefined;

/* -------------------------------------------------------------------------- */
/*                              Public API                                    */
/* -------------------------------------------------------------------------- */

/**
 * Connect to Telegram and begin listening for channel messages.
 *
 * Handles phone/OTP authentication, resolves the channel entity,
 * and subscribes to new incoming messages. Safe to call multiple times.
 *
 * @throws When authentication fails or the channel entity cannot be resolved.
 * @returns Resolves once the listener is fully attached and subscribed.
 */
export async function startTelegramListener(): Promise<void> {
  try {
    // Authenticate with Telegram (phone → OTP code → 2FA if needed)
    await telegramClient.start({
      phoneNumber: async () => ask("Phone number: "),
      phoneCode: async () => ask("Telegram code: "),
      onError: console.error,
    });

    // Persist the session so next startup skips authentication
    telegramClient.session.save();
    // Signal that we are now connected
    connectionStateInput$.next(true);
    console.log("[Telegram] Connected");
    // Resolve the channel entity by username if not already known
    if (!channelId) {
      const entity = await telegramClient.getEntity(
        CONFIG.telegramChannelUserName,
      );
      channelId = Number(entity.id);
    }
    console.log(
      `[Telegram] Listening to ${CONFIG.telegramChannelUserName} (${channelId})`,
    );
    // Create the event handler that feeds incoming messages into the RxJS stream
    eventHandler = (event: NewMessageEvent) => {
      telegramMessageInput$.next(event);
    };
    // Subscribe to new incoming messages from the target channel only
    telegramClient.addEventHandler(
      eventHandler,
      new NewMessage({
        incoming: true,
        chats: [channelId],
      }),
    );
  } catch (err) {
    // Signal disconnection state on failure
    connectionStateInput$.next(false);
    throw err;
  } finally {
    // Always close the readline interface to free stdin
    rl.close();
  }
}

/**
 * Stop listening and disconnect from Telegram.
 *
 * Completes the connection and message streams so subscribers can clean up.
 *
 * @returns Resolves when the client has fully disconnected.
 */
export async function stopTelegramListener(): Promise<void> {
  // Disconnect the MTProto client from Telegram servers
  await telegramClient.disconnect();
  // Signal to connected$ subscribers that the stream has ended
  connectionStateInput$.complete();
  // Signal to telegramSignal$ subscribers that no more messages will arrive
  telegramMessageInput$.complete();
  console.log("[Telegram] Disconnected");
}
