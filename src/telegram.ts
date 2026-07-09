import readline from "readline";
import removeMarkdown from "remove-markdown";

import { TelegramClient } from "teleproto";
import { StoreSession } from "teleproto/sessions";
import { NewMessage, NewMessageEvent } from "teleproto/events";

import { ReplaySubject, Subject, timer, BehaviorSubject, merge } from "rxjs";
import {
  distinctUntilChanged,
  filter,
  map,
  shareReplay,
  scan,
  concatMap,
} from "rxjs/operators";

import { Bot } from "grammy";
import { convert } from "telegram-markdown-v2";

import { CONFIG } from "./config";
import type { ParsedSignal, PerformanceReport } from "./types";

const parser = parseAveScannerSignal;

// ── MTProto Client ─────────────────────────────────────────────────────────

if (
  !CONFIG.telegramApiId ||
  !CONFIG.telegramApiHash ||
  !CONFIG.telegramChannelUserName
) {
  throw new Error(
    "telegramApiId, telegramApiHash and telegramChannelUserName are required",
  );
}

let _telegramClient: TelegramClient | undefined;

export function getTelegramClient(): TelegramClient {
  if (!_telegramClient) {
    _telegramClient = new TelegramClient(
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
  }
  return _telegramClient;
}

export function resetTelegramClient(): void {
  _telegramClient = undefined;
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

async function ask(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let done = false;
    const timeout = setTimeout(() => {
      if (!done) {
        done = true;
        reject(
          new Error(`Input timed out after ${CONFIG.tgAuthTimeoutMs / 1000}s`),
        );
      }
    }, CONFIG.tgAuthTimeoutMs);
    rl.question(question, (answer) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      resolve(answer.trim());
    });
  });
}

// ── Reactive Streams ───────────────────────────────────────────────────────

const telegramMessageInput$ = new Subject<NewMessageEvent>();

export const telegramSignal$ = telegramMessageInput$.pipe(
  map((e) => (e.message?.text ?? "").trim()),
  filter((t) => t.length > 0),
  map((t) => removeMarkdown(t)),
  map((t) => {
    try {
      return parser(t) as ParsedSignal | null;
    } catch {
      return null;
    }
  }),
  filter((s): s is ParsedSignal => s !== null),
  shareReplay({ bufferSize: 1, refCount: true }),
);

const connectionStateInput$ = new ReplaySubject<boolean>(1);

export const tgConnected$ = connectionStateInput$.pipe(
  shareReplay({ bufferSize: 1, refCount: true }),
);

let channelId: number | undefined = Number(CONFIG.telegramChannelId);
let eventHandler: ((event: NewMessageEvent) => void) | undefined;
let eventBuilder: NewMessage | undefined;

export async function startTelegramListener(): Promise<void> {
  const client = getTelegramClient();
  try {
    await client.start({
      phoneNumber: () => ask("Phone number: "),
      phoneCode: () => ask("Telegram code: "),
      onError: console.error,
    });
    client.session.save();
    connectionStateInput$.next(true);
    console.log("[Telegram] Connected");
    if (!channelId) {
      const entity = await client.getEntity(CONFIG.telegramChannelUserName);
      channelId = Number(entity.id);
    }
    console.log(
      `[Telegram] Listening to ${CONFIG.telegramChannelUserName} (${channelId})`,
    );
    if (eventHandler && eventBuilder) {
      try {
        client.removeEventHandler(eventHandler, eventBuilder);
      } catch {
        /* ok */
      }
    }
    eventHandler = (event: NewMessageEvent) =>
      telegramMessageInput$.next(event);
    eventBuilder = new NewMessage({ incoming: true, chats: [channelId] });
    client.addEventHandler(eventHandler, eventBuilder);
  } catch (err) {
    connectionStateInput$.next(false);
    throw err;
  } finally {
    rl.close();
  }
}

export async function stopTelegramListener(): Promise<void> {
  const client = getTelegramClient();
  if (eventHandler && eventBuilder) {
    try {
      client.removeEventHandler(eventHandler, eventBuilder);
    } catch {
      /* ok */
    }
  }
  await client.disconnect();
  connectionStateInput$.next(false);
  console.log("[Telegram] Disconnected");
}

// ── Signal Deduplication ──────────────────────────────────────────────────

interface SignalState {
  activeSignals: Map<string, number>;
  accepted?: ParsedSignal;
  expired: string[];
}

const signalEvent$ = telegramSignal$.pipe(
  map((s) => ({
    type: "signal" as const,
    signal: s,
    now: Math.floor(Date.now() / 1000),
  })),
);
const tick$ = timer(
  CONFIG.signalCleanupIntervalMs,
  CONFIG.signalCleanupIntervalMs,
).pipe(
  map(() => ({ type: "tick" as const, now: Math.floor(Date.now() / 1000) })),
);

function reduceSignalState(
  state: SignalState,
  event: { type: "signal" | "tick"; signal?: ParsedSignal; now: number },
): SignalState {
  const now = event.now;
  const active = new Map<string, number>();
  const expired: string[] = [];
  for (const [lp, ts] of state.activeSignals) {
    if (now - ts > CONFIG.signalCacheTtlSeconds) expired.push(lp);
    else active.set(lp, ts);
  }
  if (event.type === "tick")
    return { activeSignals: active, accepted: undefined, expired };
  const signal = event.signal!;
  if (active.has(signal.lpAddress))
    return { activeSignals: active, accepted: undefined, expired };
  active.set(signal.lpAddress, now);
  console.log(`[ACCEPTED] ${signal.tokenName}`);
  return { activeSignals: active, accepted: signal, expired };
}

const INITIAL: SignalState = { activeSignals: new Map(), expired: [] };

const merged$ = merge(signalEvent$, tick$) as any;
export const signalState$ = merged$.pipe(
  scan(reduceSignalState as any, INITIAL),
  shareReplay({ bufferSize: 1, refCount: false }),
) as any;
signalState$.subscribe((s: SignalState) => {
  latestSignalState = s;
});

export let latestSignalState: SignalState = INITIAL;

export const acceptedSignal$ = signalState$.pipe(
  filter((s: SignalState) => s.accepted !== undefined),
  map((s: SignalState) => s.accepted!),
);
export const expiredPair$ = signalState$.pipe(
  filter((s: SignalState) => s.expired.length > 0),
  map((s: SignalState) => s.expired),
);

// ── Signal Pause / Resume ─────────────────────────────────────────────────

const _paused$ = new BehaviorSubject<boolean>(false);
export const signalPaused$ = _paused$.pipe(distinctUntilChanged());

export function pauseSignals(): void {
  if (_paused$.value) return;
  _paused$.next(true);
  console.log("[signal] Paused");
}

export function resumeSignals(): void {
  if (!_paused$.value) return;
  _paused$.next(false);
  console.log("[signal] Resumed");
}

export function isSignalPaused(): boolean {
  return _paused$.value;
}

// ── Bot Reporter (grammy) ──────────────────────────────────────────────────

const bot = new Bot(CONFIG.telegramBotToken!);
const CHAT_ID = CONFIG.telegramChatId!;

function fmtPnL(value: number, suffix = ""): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}${suffix}`;
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

function closeIcon(reason: string): string {
  switch (reason) {
    case "take_profit":
      return "\u{1F7E2}";
    case "stop_loss":
      return "\u{1F534}";
    case "trailing_stop":
      return "\u{1F7E1}";
    case "expired":
      return "\u{23F0}";
    default:
      return "\u{26A0}\uFE0F";
  }
}

function reasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    take_profit: "Take Profit",
    stop_loss: "Stop Loss",
    trailing_stop: "Trailing Stop",
    expired: "TTL Expired",
    manual: "Manual",
  };
  return labels[reason] ?? reason;
}

export interface ReporterCallbacks {
  getReport: () => PerformanceReport;
  getBalanceStr: () => string;
  openPositions$: import("rxjs").Observable<any[]>;
  positionEvent$: import("rxjs").Observable<any>;
  positionClosed$: import("rxjs").Observable<any>;
}

class TelegramReporter {
  private send$ = new Subject<string>();
  private subs: import("rxjs").Subscription[] = [];
  private cbs!: ReporterCallbacks;
  openCount = 0;

  wire(cbs: ReporterCallbacks): void {
    this.cbs = cbs;
  }

  start(): void {
    if (this.subs.length > 0) return;
    this.send$.pipe(concatMap((text) => this.sendWithRetry(text))).subscribe();
    this.cbs.openPositions$.subscribe((ps: any[]) => {
      this.openCount = ps.length;
    });
    this.subs.push(
      this.cbs.positionEvent$
        .pipe(filter((ev: any) => ev.type === "opened"))
        .subscribe((ev: any) => {
          try {
            this.send(this.openedMessage(ev));
          } catch {
            /* ok */
          }
        }),
    );
    this.subs.push(
      this.cbs.positionClosed$.subscribe((ev: any) => {
        try {
          this.send(this.closedMessage(ev));
        } catch {
          /* ok */
        }
      }),
    );
    const intervalMs = CONFIG.reportIntervalMinutes * 60 * 1000;
    if (intervalMs > 0) {
      this.subs.push(
        timer(intervalMs, intervalMs)
          .pipe(
            map(() => {
              try {
                return this.cbs.getReport();
              } catch {
                return null;
              }
            }),
            distinctUntilChanged((a, b) =>
              a === null || b === null
                ? false
                : JSON.stringify(a) === JSON.stringify(b),
            ),
            filter((r): r is PerformanceReport => r !== null),
          )
          .subscribe((r) => this.send(this.summaryMessage(r))),
      );
    }
  }

  stop(): void {
    for (const s of this.subs) s.unsubscribe();
    this.subs = [];
    bot.stop();
  }

  sendMessage(text: string): void {
    this.send$.next(text);
  }

  private send(text: string): void {
    this.send$.next(text);
  }

  private async sendWithRetry(text: string, retries = 3): Promise<void> {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        await bot.api.sendMessage(CHAT_ID, text, { parse_mode: "MarkdownV2" });
        return;
      } catch {
        if (attempt < retries - 1)
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }

  private openedMessage(ev: any): string {
    const p = ev.position;
    const report = this.cbs.getReport();
    const sig = p.signal ?? {};
    const lines: string[] = [
      "\u{1F7E2} **Position Opened**",
      "",
      `\u{1F512} Token: \`${p.tokenName}\``,
      `\u{1F4B0} Size: **${p.sizeSol.toFixed(2)} SOL**`,
      `\u{23F0} Time: \`${new Date(p.openedAt).toLocaleTimeString()}\``,
    ];
    if (sig.maxPumpX > 0)
      lines.push(`\u{1F680} Max Pump: **x${sig.maxPumpX}**`);
    lines.push("", this.cbs.getBalanceStr());
    lines.push(
      `\u{1F4CC} Positions: \`${report.openPositions} / ${CONFIG.maxPositions}\``,
    );
    return convert(lines.join("\n"));
  }

  private closedMessage(ev: any): string {
    const p = ev.position;
    const report = this.cbs.getReport();
    const profit = p.currentProfitPercent ?? 0;
    const reason = p.closeReason ?? "?";
    const duration = fmtDuration(
      (p.lastUpdateAt ?? Date.now()) - (p.openedAt ?? Date.now()),
    );
    const lines: string[] = [
      `${profit >= 0 ? "\u{1F7E2}" : "\u{1F534}"} **Position Closed** ${profit >= 0 ? "\u{2705}" : "\u{274C}"}`,
      "",
      `\u{1F512} Token: \`${p.tokenName}\``,
      p.entryPriceUsd != null
        ? `\u{1F4B5} Entry: \`$${p.entryPriceUsd.toFixed(8)}\``
        : "",
      `\u{1F517} Reason: ${closeIcon(reason)} **${reasonLabel(reason)}**`,
      `\u{23F1}\uFE0F Duration: \`${duration}\``,
      "",
      this.cbs.getBalanceStr(),
      `\u{1F4CC} Positions: \`${report.openPositions} / ${CONFIG.maxPositions}\``,
    ];
    return convert(lines.filter(Boolean).join("\n"));
  }

  private summaryMessage(report: PerformanceReport): string {
    const lines: string[] = [
      "\u{1F4CA} **Performance Report**",
      "",
      "Mode: " +
        (CONFIG.liveMode ? "\u{1F4E1}" : "\u{1F9EA}") +
        " `" +
        (CONFIG.liveMode ? "Live" : "Simulate") +
        "`",
      "",
      "---\n",
      this.cbs.getBalanceStr(),
      "",
      `\u{1F4CC} Positions: \`${report.openPositions} / ${CONFIG.maxPositions}\``,
      `\u{2705} Closed: \`${report.closedPositions}\``,
      `\u{1F4CB} Total: \`${report.totalPositions}\``,
      "",
      `**Results** ${report.winRate >= 50 ? "\u{1F3C6}" : "\u{26A0}\uFE0F"}`,
      `\u{2705} Wins: \`${report.winningTrades}\``,
      `\u{274C} Losses: \`${report.losingTrades}\``,
      `\u{1F3AF} Win Rate: **${report.winRate.toFixed(1)}%**`,
      "",
      `**PnL Summary**`,
      `\u{1F4B0} Total PnL: **${fmtPnL(report.totalProfitPct)}%** (${fmtPnL(report.totalProfitUsd, "$")})`,
      `\u{1F4C8} Best: **${fmtPnL(report.bestTradePct)}%**`,
      `\u{1F4A9} Worst: **${fmtPnL(report.worstTradePct)}%**`,
    ];
    if (Object.keys(report.reasons).length > 0) {
      lines.push("", "**Close Reasons**");
      for (const [r, count] of Object.entries(report.reasons)) {
        lines.push(`${closeIcon(r)} **${reasonLabel(r)}**: \`${count}\``);
      }
    }
    return convert(lines.join("\n"));
  }
}

export const reporter = new TelegramReporter();

bot.command("start", async (ctx) => {
  resumeSignals();
  await ctx.reply("\u25B6\uFE0F Signal processing resumed");
});
bot.command("pause", async (ctx) => {
  pauseSignals();
  await ctx.reply("\u23F8\uFE0F Signal processing paused");
});
bot.command("status", async (ctx) => {
  await ctx.reply(
    `${isSignalPaused() ? "\u23F8\uFE0F" : "\u25B6\uFE0F"} Signal: **${isSignalPaused() ? "Paused" : "Active"}**\n` +
      `\u{1F4CC} Open positions: ${reporter.openCount}`,
  );
});
bot.command("panic", async (ctx) => {
  pauseSignals();
  await ctx.reply("\u{1F6A8} **PANIC MODE** — New positions disabled");
});

bot
  .start({ onStart: () => console.log("[reporter] Bot polling started") })
  .catch((err) => console.error("[reporter] Bot polling failed:", err));

export function startReporter(): void {
  reporter.start();
}
export function stopReporter(): void {
  reporter.stop();
}
export function sendMessage(text: string): void {
  reporter.sendMessage(text);
}
export function wireReporter(cbs: ReporterCallbacks): void {
  reporter.wire(cbs);
}
