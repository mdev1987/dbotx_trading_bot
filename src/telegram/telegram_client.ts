import readline from "readline";
import removeMarkdown from "remove-markdown";
import { TelegramClient } from "teleproto";
import { StoreSession } from "teleproto/sessions";
import { NewMessage, NewMessageEvent } from "teleproto/events";
import { BehaviorSubject, Subject } from "rxjs";
import { distinctUntilChanged, shareReplay } from "rxjs/operators";
import { CONFIG } from "../config";
import {
  parseAveScannerSignal,
  type AveScannerSignal,
} from "./ave_scanner_parser";
import { parseSolTrendingSignal } from "./sol_trading_parser";
import { parseTrendingssolSignal } from "./sol_trending2_parser";

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
let telegramClient: TelegramClient | undefined;

export function getTelegramClient(): TelegramClient {
  if (telegramClient) {
    return telegramClient;
  }
  telegramClient = new TelegramClient(
    new StoreSession(CONFIG.telegramSessionName),
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
export function resetTelegramClient(): void {
  telegramClient = undefined;
}

/* -------------------------------------------------------------------------- */
/*                              Console Helpers                               */
/* -------------------------------------------------------------------------- */
function createReadline() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

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

const connectionStateInput$ = new BehaviorSubject<boolean>(false);
export const tgConnected$ = connectionStateInput$.pipe(
  distinctUntilChanged(),
  shareReplay({
    bufferSize: 1,
    refCount: true,
  }),
);

export const telegramSignal$ = new Subject<AveScannerSignal>();

let telegramChannelId: number | undefined = CONFIG.telegramChannelId
  ? Number(CONFIG.telegramChannelId)
  : undefined;

let telegramEventHandler: ((event: NewMessageEvent) => void) | undefined;
let telegramEventBuilder: NewMessage | undefined;

/* -------------------------------------------------------------------------- */
/*                          Telegram Listener Start                           */
/* -------------------------------------------------------------------------- */

function reconstructWithUrls(rawMessage: string, entities: any[]): string {
  const textUrls = entities
    .filter((e: any) => e.className === "MessageEntityTextUrl")
    .map((e: any) => ({ offset: e.offset, length: e.length, url: e.url }))
    .sort((a: any, b: any) => b.offset - a.offset);

  let result = rawMessage;
  for (const tu of textUrls) {
    const before = result.slice(0, tu.offset + tu.length);
    const after = result.slice(tu.offset + tu.length);
    result = before + ` (${tu.url})` + after;
  }

  return result;
}

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
    client.session.save();
    connectionStateInput$.next(true);
    console.log("[Telegram] Connected");

    telegramChannelId = CONFIG.telegramChannelId
      ? Number(CONFIG.telegramChannelId)
      : undefined;
    if (!telegramChannelId) {
      const entity = await client.getEntity(CONFIG.telegramChannelUserName);
      telegramChannelId = Number(entity.id);
    }
    console.log(
      `[Telegram] Listening to ${CONFIG.telegramChannelUserName} (${telegramChannelId})`,
    );

    if (telegramEventHandler && telegramEventBuilder) {
      try {
        client.removeEventHandler(telegramEventHandler, telegramEventBuilder);
      } catch (err) {
        console.warn("[Telegram] Failed to remove old event handler:", err);
      }
    }
    telegramEventHandler = (event) => {
      const msg = event.message;
      const rawMessage = (msg as any)?.message ?? "";
      const entities: any[] = (msg as any)?.entities ?? [];
      const text = reconstructWithUrls(rawMessage, entities);

      const signal =
        parseSolTrendingSignal(text) ??
        parseTrendingssolSignal(text) ??
        parseAveScannerSignal(text);
      if (!signal) {
        return;
      }
      console.log("[Telegram] Parsed signal:", signal.Token, signal.CA?.slice(0, 8));
      telegramSignal$.next(signal);
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

export async function stopTelegramListener(): Promise<void> {
  const client = getTelegramClient();
  try {
    if (telegramEventHandler && telegramEventBuilder) {
      try {
        client.removeEventHandler(telegramEventHandler, telegramEventBuilder);
      } catch (err) {
        console.warn("[Telegram] Failed to remove event handler on stop:", err);
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

export async function shutdownTelegram(): Promise<void> {
  try {
    await stopTelegramListener();
  } finally {
    connectionStateInput$.next(false);
    telegramChannelId = undefined;
    telegramEventHandler = undefined;
    telegramEventBuilder = undefined;
    resetTelegramClient();
  }
}
