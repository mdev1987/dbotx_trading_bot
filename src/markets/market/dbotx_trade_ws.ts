import { BehaviorSubject, Subject, Observable, interval } from "rxjs";

import { filter, map, share, shareReplay, switchMap } from "rxjs/operators";

import { CONFIG } from "../../config";

import type {
  AckMessage,
  ConnectionState,
  ErrorMessage,
  WsMessage,
} from "../types/websocket";

import type { TradeEvent } from "../types/trade";

const ws$ = new BehaviorSubject<WebSocket | null>(null);

const connectionState$ = new BehaviorSubject<ConnectionState>("disconnected");

const connected$ = connectionState$.pipe(
  filter((state) => state === "connected"),
  shareReplay(1),
);

const connectionAck$ = new Subject<AckMessage>();

const subscriptionAck$ = new Subject<AckMessage>();

const error$ = new Subject<Error>();

const message$ = new Subject<WsMessage>();

let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function socket(): WebSocket | null {
  const ws = ws$.value;

  if (!ws) return null;

  return ws.readyState === WebSocket.OPEN ? ws : null;
}

function reconnect() {
  if (reconnectTimer) return;

  connectionState$.next("reconnecting");

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, CONFIG.wsReconnectDelayMs);
}

export function connect() {
  if (
    connectionState$.value === "connecting" ||
    connectionState$.value === "connected"
  ) {
    return;
  }

  ws$.value?.close();

  connectionState$.next("connecting");

  const ws = new WebSocket(CONFIG.tradeWsUrl, {
    headers: {
      "x-api-key": CONFIG.dbotxApiKey,
    },
  });

  ws.onopen = () => {
    ws$.next(ws);
  };

  ws.onmessage = ({ data }) => {
    try {
      if (typeof data !== "string") return;

      message$.next(JSON.parse(data));
    } catch (err) {
      error$.next(err instanceof Error ? err : new Error("Invalid message"));
    }
  };

  ws.onerror = () => {
    error$.next(new Error("Trade websocket error"));
  };

  ws.onclose = () => {
    ws$.next(null);

    reconnect();
  };
}

export function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);

    reconnectTimer = null;
  }

  connectionState$.next("disconnected");

  ws$.value?.close();

  ws$.next(null);
}

message$
  .pipe(filter((msg): msg is AckMessage => msg.status === "ack"))
  .subscribe((msg) => {
    switch (msg.method) {
      case "connectionResponse":
        connectionState$.next("connected");

        connectionAck$.next(msg);

        break;

      case "subscribeResponse":
        subscriptionAck$.next(msg);

        break;
    }
  });

message$
  .pipe(filter((msg): msg is ErrorMessage => msg.status === "error"))
  .subscribe((msg) => error$.next(new Error(msg.message)));

const tradeEvents$: Observable<TradeEvent> = message$.pipe(
  filter((msg) => msg.status !== "ack" && "event" in msg),
  map((msg) => msg as TradeEvent),
  share(),
);

export const success$ = tradeEvents$.pipe(
  filter((event) => event.type.endsWith("_success")),
);

export const failure$ = tradeEvents$.pipe(
  filter((event) => event.type.endsWith("_failed")),
);

export const tp$ = tradeEvents$.pipe(filter((event) => event.type === "tp"));

export const sl$ = tradeEvents$.pipe(filter((event) => event.type === "sl"));

export const trailing$ = tradeEvents$.pipe(
  filter((event) => event.type === "trailing"),
);

connected$
  .pipe(switchMap(() => interval(CONFIG.wsHeartbeatIntervalMs)))
  .subscribe(() => {
    const ws = socket();

    if (!ws) return;

    try {
      ws.ping();
    } catch {}
  });

export {
  connected$,
  connectionState$,
  connectionAck$,
  subscriptionAck$,
  error$,
};

import { firstValueFrom } from "rxjs";

import { filter, timeout } from "rxjs/operators";

import type { TradeRequest, TradeResponse } from "../types/trade";

const pending = new Map<string, Subject<TradeResponse>>();

function send(payload: unknown): boolean {
  const ws = socket();

  if (!ws) return false;

  ws.send(JSON.stringify(payload));

  return true;
}

message$
  .pipe(filter((msg): msg is TradeResponse => "requestId" in msg))
  .subscribe((msg) => {
    const subject = pending.get(msg.requestId);

    if (!subject) return;

    subject.next(msg);

    subject.complete();

    pending.delete(msg.requestId);
  });

export async function execute(request: TradeRequest): Promise<TradeResponse> {
  const requestId = crypto.randomUUID();

  const response$ = new Subject<TradeResponse>();

  pending.set(requestId, response$);

  const ok = send({
    requestId,
    ...request,
  });

  if (!ok) {
    pending.delete(requestId);

    throw new Error("Trade websocket disconnected.");
  }

  return await firstValueFrom(response$.pipe(timeout(CONFIG.tradeTimeoutMs)));
}

export async function buy(request: Omit<TradeRequest, "side">) {
  return execute({
    ...request,
    side: "buy",
  });
}

export async function sell(request: Omit<TradeRequest, "side">) {
  return execute({
    ...request,
    side: "sell",
  });
}

export const trade = {
  connect,

  disconnect,

  buy,

  sell,

  execute,

  connected$,

  connectionAck$,

  connectionState$,

  error$,
};
