/* ============================================================
 * telegram_listener.ts
 *
 * Reactive Telegram listener using:
 *
 * - teleproto (MTProto client)
 * - RxJS
 * - remove-markdown
 *
 * Listens to a single Telegram channel.  The active parser and
 * behaviour are determined by SIGNAL_SOURCE_MODE:
 *
 *   'monitor' — Ave Signal Monitor (no TTL, no max pos, pump TP)
 *   'ave'     — AVE Scanner (TTL, max pos, queue, config TP)
 *
 * ============================================================
 */

import readLine from "readline";
import removeMarkdown from "remove-markdown";

import { TelegramClient } from "teleproto";
import { StoreSession } from "teleproto/sessions";
import { NewMessage, NewMessageEvent } from "teleproto/events";

import { Observable, Subject } from "rxjs";

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
  signalSourceMode,
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
 */

const telegramMessageInput$ = new Subject<NewMessageEvent>();

export const telegramMessage$ = telegramMessageInput$.pipe(share());

export const telegramText$ = telegramMessage$.pipe(
  map((event) => event.message?.text ?? ""),
  filter((text) => text.trim().length > 0),
  share(),
);

export const cleanedTelegramText$ = telegramText$.pipe(
  map((text) => removeMarkdown(text)),
  share(),
);

/* ============================================================
 * Parsed signal stream & pump result stream
 *
 * The parser depends on signalSourceMode:
 *   'monitor' — parse Signal Monitor messages (signal + pump)
 *   'ave'     — parse AVE Scanner messages (signal only)
 * ============================================================
 */

/** Subject for pump results (fed in monitor mode; silent in ave mode). */
const pumpInput$ = new Subject<AveSignalMonitorPump>();

export const signalMonitorPump$: Observable<AveSignalMonitorPump> =
  pumpInput$.pipe(share());

export let signal$: Observable<SolanaPoolSignal>;

if (signalSourceMode === "monitor") {
  /* ---- Monitor mode: Signal Monitor parser ------------------- */

  const convertedSignal$ = cleanedTelegramText$.pipe(
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
    share(),
  );

  signal$ = convertedSignal$;

  /* Parse pump results from the same text stream. */
  cleanedTelegramText$
    .pipe(
      map((text) => parseSignalMonitorPump(text)),
      filter((r): r is AveSignalMonitorPump => r !== null),
    )
    .subscribe((pump) => pumpInput$.next(pump));
} else {
  /* ---- AVE mode: AVE Scanner parser ------------------------- */

  signal$ = cleanedTelegramText$.pipe(
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
    share(),
  );
}

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

  console.log(
    `[Telegram] Listening to ${telegramChannelUserName} (${channelId}) — mode: ${signalSourceMode}`,
  );

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
  pumpInput$.complete();
  await telegramClient.disconnect();
  console.log("[Telegram] Client disconnected");
}
