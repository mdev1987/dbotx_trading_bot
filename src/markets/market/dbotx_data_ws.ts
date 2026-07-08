import { Subject } from "rxjs";

import { filter, map, share } from "rxjs/operators";

import { CONFIG } from "../../config";

import { WebSocketTransport } from "../transport/websocket";

import { RequestManager } from "../transport/request";

import type { AckMessage, WsMessage } from "../types/websocket";

import type { TradeRequest, TradeResponse, TradeEvent } from "../types/trade";

const transport = new WebSocketTransport({
  url: CONFIG.tradeWsUrl,
  apiKey: CONFIG.dbotxApiKey,
  reconnectDelay: CONFIG.wsReconnectDelayMs,
  heartbeatInterval: CONFIG.wsHeartbeatIntervalMs,
});

const requests = new RequestManager<TradeResponse>(CONFIG.tradeTimeoutMs);

const connectionAck$ = new Subject<AckMessage>();

const error$ = transport.error$;

const message$ = transport.message$.pipe(
  map((message) => message as WsMessage),
  share(),
);

message$
  .pipe(
    filter(
      (message): message is AckMessage =>
        "status" in message && message.status === "ack",
    ),
  )
  .subscribe((message) => {
    if (message.method === "connectionResponse") {
      connectionAck$.next(message);
    }
  });

message$
  .pipe(filter((message): message is TradeResponse => "requestId" in message))
  .subscribe((response) => {
    requests.resolve(response.requestId, response);
  });

export const events$ = message$.pipe(
  filter((message): message is TradeEvent => "event" in message),
  share(),
);

export const buyFilled$ = events$.pipe(
  filter((event) => event.event === "buyFilled"),
);

export const sellFilled$ = events$.pipe(
  filter((event) => event.event === "sellFilled"),
);

export const tpTriggered$ = events$.pipe(
  filter((event) => event.event === "tpTriggered"),
);

export const slTriggered$ = events$.pipe(
  filter((event) => event.event === "slTriggered"),
);

export const trailingTriggered$ = events$.pipe(
  filter((event) => event.event === "trailingTriggered"),
);

export function connect(): void {
  transport.connect();
}

export function disconnect(): void {
  transport.disconnect();

  requests.clear();
}

export { transport, requests, connectionAck$, error$ };

async function execute(request: TradeRequest): Promise<TradeResponse> {
  const pending = requests.create();

  const ok = transport.send({
    ...request,
    requestId: pending.id,
  });

  if (!ok) {
    requests.reject(pending.id, new Error("Trade websocket disconnected."));

    throw new Error("Trade websocket disconnected.");
  }

  return requests.wait(pending);
}

export function buy(
  request: Omit<TradeRequest, "side">,
): Promise<TradeResponse> {
  return execute({
    ...request,
    side: "buy",
  });
}

export function sell(
  request: Omit<TradeRequest, "side">,
): Promise<TradeResponse> {
  return execute({
    ...request,
    side: "sell",
  });
}

export function createTpSl(
  request: Omit<TradeRequest, "method">,
): Promise<TradeResponse> {
  return execute({
    ...request,
    method: "createTpSl",
  });
}

export function updateTpSl(
  request: Omit<TradeRequest, "method">,
): Promise<TradeResponse> {
  return execute({
    ...request,
    method: "updateTpSl",
  });
}

export function cancelTpSl(taskId: string): Promise<TradeResponse> {
  return execute({
    method: "cancelTpSl",
    taskId,
  });
}

export function createTrailingStop(
  request: Omit<TradeRequest, "method">,
): Promise<TradeResponse> {
  return execute({
    ...request,
    method: "createTrailingStop",
  });
}

export function updateTrailingStop(
  request: Omit<TradeRequest, "method">,
): Promise<TradeResponse> {
  return execute({
    ...request,
    method: "updateTrailingStop",
  });
}

export function cancelTrailingStop(taskId: string): Promise<TradeResponse> {
  return execute({
    method: "cancelTrailingStop",
    taskId,
  });
}

export const trade = {
  connect,
  disconnect,

  buy,
  sell,

  createTpSl,
  updateTpSl,
  cancelTpSl,

  createTrailingStop,
  updateTrailingStop,
  cancelTrailingStop,

  events$,

  buyFilled$,
  sellFilled$,

  tpTriggered$,
  slTriggered$,
  trailingTriggered$,

  connected$: transport.connected$,

  error$,

  connectionAck$,
};
