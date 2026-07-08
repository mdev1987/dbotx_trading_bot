import { CONFIG } from "../../config";

import { RestClient } from "../transport/rest";

import type { TradeRequest, TradeResponse, OrderStatus } from "../types/trade";

const client = new RestClient({
  baseUrl: CONFIG.tradeRestUrl,
  apiKey: CONFIG.dbotxApiKey,
  retry: {
    retries: CONFIG.restRetries,
    delay: CONFIG.restRetryDelayMs,
  },
});

export async function execute(request: TradeRequest): Promise<TradeResponse> {
  return client.post<TradeResponse>("/fastSwap", request);
}

export async function buy(
  request: Omit<TradeRequest, "side">,
): Promise<TradeResponse> {
  return execute({
    ...request,
    side: "buy",
  });
}

export async function sell(
  request: Omit<TradeRequest, "side">,
): Promise<TradeResponse> {
  return execute({
    ...request,
    side: "sell",
  });
}

export async function order(orderId: string): Promise<OrderStatus> {
  return client.get<OrderStatus>(`/swapOrder/${orderId}`);
}

export async function orders(
  orderIds: readonly string[],
): Promise<OrderStatus[]> {
  return client.post<OrderStatus[]>("/swapOrders", {
    orderIds,
  });
}

export async function createTpSl(
  request: Omit<TradeRequest, "method">,
): Promise<TradeResponse> {
  return client.post<TradeResponse>("/swapTpSlTasks", {
    ...request,
    method: "create",
  });
}

export async function updateTpSl(
  request: Omit<TradeRequest, "method">,
): Promise<TradeResponse> {
  return client.post<TradeResponse>("/swapTpSlTasks", {
    ...request,
    method: "update",
  });
}

export async function cancelTpSl(taskId: string): Promise<TradeResponse> {
  return client.post<TradeResponse>("/swapTpSlTasks", {
    method: "cancel",
    taskId,
  });
}

export async function trailingStop(
  request: Omit<TradeRequest, "method">,
): Promise<TradeResponse> {
  return client.post<TradeResponse>("/trailingStopTasks", {
    ...request,
    method: "create",
  });
}

export async function updateTrailingStop(
  request: Omit<TradeRequest, "method">,
): Promise<TradeResponse> {
  return client.post<TradeResponse>("/trailingStopTasks", {
    ...request,
    method: "update",
  });
}

export async function cancelTrailingStop(
  taskId: string,
): Promise<TradeResponse> {
  return client.post<TradeResponse>("/trailingStopTasks", {
    method: "cancel",
    taskId,
  });
}

export const tradeApi = {
  execute,

  buy,
  sell,

  order,
  orders,

  createTpSl,
  updateTpSl,
  cancelTpSl,

  trailingStop,
  updateTrailingStop,
  cancelTrailingStop,
};
