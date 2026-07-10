import { Subject } from "rxjs";
import { PriceSource, type DexPair, type DexScreenerEvent } from "./types";

const DEX_API = "https://api.dexscreener.com/tokens/v1/solana";

export const dexScreenerPriceUpdateEvent$ = new Subject<DexScreenerEvent>();

export async function pollDexScreener(tokens: string[]): Promise<void> {
  if (tokens.length === 0) {
    return;
  }

  try {
    const res = await fetch(`${DEX_API}/${tokens.join(",")}`);

    if (!res.ok) {
      return;
    }

    const pairs = (await res.json()) as DexPair[];
    const timestamp = Date.now();

    for (const pair of pairs) {
      const priceUsd = Number(pair.priceUsd);

      if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
        continue;
      }

      dexScreenerPriceUpdateEvent$.next({
        token: pair.baseToken.address,
        pair: pair.pairAddress,
        priceUsd,
        source: PriceSource.DEXSCREENER,
        timestamp,
      });
    }
  } catch {
    // Ignore polling errors.
  }
}
