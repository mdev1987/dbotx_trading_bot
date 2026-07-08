import { CONFIG } from "../../config";

import { RestClient } from "../transport/rest";

import type {
  PairInfo,
  PairInfoResponse,
  PairSubscription,
} from "../types/market";

const client = new RestClient({
  baseUrl: CONFIG.restUrl,
  apiKey: CONFIG.dbotxApiKey,
  retry: {
    retries: CONFIG.restRetries,
    delay: CONFIG.restRetryDelayMs,
  },
});

export async function pair(address: string): Promise<PairInfo> {
  const response = await client.get<PairInfoResponse>(`/pair/${address}`);

  return response.result;
}

export async function pairs(addresses: readonly string[]): Promise<PairInfo[]> {
  if (!addresses.length) {
    return [];
  }

  const response = await client.post<PairInfoResponse[]>("/pairs", {
    pairs: addresses.map((pair) => ({
      pair,
    })),
  });

  return response.map(({ result }) => result);
}

export async function refresh(
  subscription: PairSubscription,
): Promise<PairInfo> {
  return pair(subscription.pair);
}

export async function refreshMany(
  subscriptions: readonly PairSubscription[],
): Promise<PairInfo[]> {
  return pairs(subscriptions.map(({ pair }) => pair));
}

export async function price(pair: string): Promise<number> {
  const info = await pair(pair);

  return info.tp;
}

export async function prices(
  pairsList: readonly string[],
): Promise<Map<string, number>> {
  const result = await pairs(pairsList);

  return new Map(result.map((pair) => [pair.p, pair.tp]));
}

export async function exists(pair: string): Promise<boolean> {
  try {
    await refresh({
      pair,
    });

    return true;
  } catch {
    return false;
  }
}

export const dataApi = {
  pair,
  pairs,

  price,
  prices,

  refresh,
  refreshMany,

  exists,
};
