import { TelegramClient } from "telegram";
import { StoreSession } from "telegram/sessions";
import { CONFIG } from "../config";
import readLine from "readline";
import removeMarkdown from "remove-markdown";
import { NewMessageEvent, NewMessage } from "telegram/events";
import {
  parseSolanaPoolSignal,
  type SolanaPoolSignal,
} from "./ave_scanner_parser";
const { telegram_api_id, telegram_api_hash, telegram_channel_username } =
  CONFIG;

if (!telegram_api_id || !telegram_api_hash || !telegram_channel_username) {
  throw new Error("Telegram API ID, hash, and channel username are required");
}

const rl = readLine.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const client = new TelegramClient(
  new StoreSession("telegram_session"),
  Number(telegram_api_id),
  telegram_api_hash,
  {
    connectionRetries: 5,
    //autoReconnect: true,
    //reconnectRetries: 5, default infinity
    //retryDelay: 1000,
    //requestRetries: 5,
  },
);

function handleTelegramMessage(
  event: NewMessageEvent,
): SolanaPoolSignal | null {
  const text = event.message?.text;
  if (!text) {
    console.error("Empty message");
    return null;
  }
  try {
    const text_removed_markdown = removeMarkdown(text);
    const signal = parseSolanaPoolSignal(text_removed_markdown);
    console.dir(signal, {
      depth: null,
    });
    return signal;
  } catch (error) {
    console.log(event.message);
    console.error("Failed to parse pool signal:", error);
    return null;
  }
}

export async function startTelegramListener() {
  try {
    await client.start({
      phoneNumber: async () =>
        new Promise((resolve) =>
          rl.question("Please enter your number: ", resolve),
        ),
      phoneCode: async () =>
        new Promise((resolve) =>
          rl.question("Please enter the code: ", resolve),
        ),
      onError: (err) => console.error(err),
    });
    client.session.save();
    console.log("Telegram client started");
  } finally {
    rl.close();
  }

  // Listen to a channel
  // const channel = await client.getEntity(telegram_channel_username!);
  // console.log(`Listening to ${telegram_channel_username} (${channel.id})`);
  // AveSolanaTokenScanner (1997921344)
  //   {
  //     channel_id: 1997921344,
  //     bot_api_chat_id: -1001997921344,
  //     username: "AveSolanaTokenScanner"
  // }
  const channel_id = 1997921344; // AveSolanaTokenScanner
  console.log(`Listening to ${telegram_channel_username} (${channel_id})`);
  client.addEventHandler(
    (event: NewMessageEvent) => handleTelegramMessage(event),
    new NewMessage({
      incoming: true,
      chats: [channel_id],
    }),
  );
}

export async function stopTelegramListener() {
  await client.disconnect();
}
