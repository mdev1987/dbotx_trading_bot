import { CONFIG } from "../../../config";
import { botHttp } from "../../http";
import { addPosition } from "../../../strategy/positions_store";
import { trackToken, getSolPriceUsd } from "../../../data_stream/price_engine";
import {
  getStoreOrders,
  getStoreOpenPositions,
  addPosition as storeAddPosition,
  type StoredOrder,
  type StoredPosition,
} from "./store";

const MAX_RECOVERY_PAGES = 10;
const RECOVERY_PAGE_DELAY_MS = 200;
const RECOVERY_TRADE_DELAY_MS = 100;

export const __TEST_DELAY_OVERRIDE = { fn: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };

function delay(ms: number): Promise<void> {
  return __TEST_DELAY_OVERRIDE.fn(ms);
}

interface SwapTrade {
  id: string;
  timestamp: number;
  createAt: number;
  state: string;
  chain: string;
  wallet: string;
  type: "buy" | "sell";
  pair: string;
  send: { amount: string; info: { contract: string; decimals: number; symbol: string } };
  receive: { amount: string; info: { contract: string; decimals: number; name: string; symbol: string } };
}

interface SwapTradesResponse {
  err: boolean;
  res: SwapTrade[];
}

interface PnlOrder {
  id: string;
  state: string;
  tradeType: "buy" | "sell";
  pair: string;
  basePriceUsd: number;
  txPriceUsd?: number;
  sourceId: string;
}

interface PnlOrdersResponse {
  err: boolean;
  res: PnlOrder[];
}

export async function recoverLivePositions(): Promise<void> {
  const storeOrders = getStoreOrders();
  const storeOpenPositions = getStoreOpenPositions();

  if (storeOpenPositions.length > 0) {
    console.log(`[Recovery] Found ${storeOpenPositions.length} open positions in store`);
    for (const pos of storeOpenPositions) {
      const restored = addPosition(pos.token, pos.pair, pos.tokenName, pos.entryPriceUsd, pos.sizeSol);
      if (restored) {
        trackToken(pos.token, pos.pair);
        console.log(`[Recovery] Restored position: ${pos.tokenName} @ ${pos.entryPriceUsd}`);
      }
    }
    return;
  }

  if (!CONFIG.walletAddress) {
    console.log("[Recovery] No wallet address configured — skipping API recovery");
    return;
  }

  console.log("[Recovery] Fetching recent trades for recovery...");
  try {
    let solPrice = getSolPriceUsd();
    if (solPrice <= 0) {
      for (let i = 0; i < 10; i++) {
        await delay(1000);
        solPrice = getSolPriceUsd();
        if (solPrice > 0) break;
      }
    }

    let page = 0;
    let allTrades: SwapTrade[] = [];

    while (page < MAX_RECOVERY_PAGES) {
      const trades = await botHttp.get<SwapTradesResponse>(
        `/account/swap_trades?page=${page}&size=${CONFIG.recoveryFetchPageSize}&chain=solana`,
      );

      if (trades.err || !trades.res || trades.res.length === 0) break;

      allTrades = allTrades.concat(trades.res);
      if (trades.res.length < CONFIG.recoveryFetchPageSize) break;
      page++;
      if (page < MAX_RECOVERY_PAGES) {
        await delay(RECOVERY_PAGE_DELAY_MS);
      }
    }

    const recentBuys = allTrades.filter((t) => t.type === "buy" && t.state === "done");

    for (const trade of recentBuys) {
      const pair = trade.pair;
      if (storeOrders.some((o) => o.pair === pair)) continue;

      const tokenContract = trade.receive.info.contract;
      const tokenName = trade.receive.info.name || trade.receive.info.symbol || tokenContract.slice(0, 8);

      const sendAmount = Number(trade.send.amount) / 10 ** (trade.send.info.decimals || 9);
      const receiveAmount = Number(trade.receive.amount) / 10 ** trade.receive.info.decimals;
      let entryPriceUsd = 0;
      if (receiveAmount > 0) {
        entryPriceUsd = solPrice > 0 ? (sendAmount / receiveAmount) * solPrice : 0;
      }

      const activeExits = await findActiveExits(trade.id);
      await delay(RECOVERY_TRADE_DELAY_MS);
      if (activeExits.length > 0 && activeExits[0]!.basePriceUsd > 0) {
        entryPriceUsd = activeExits[0]!.basePriceUsd;
      }

      if (entryPriceUsd <= 0) {
        console.log(`[Recovery] Skipping ${tokenName} — no entry price`);
        continue;
      }

      const sizeSol = sendAmount;

      const hasActiveExit = activeExits.some((e) => e.state === "init" || e.state === "processing");
      if (!hasActiveExit && activeExits.length > 0) {
        console.log(`[Recovery] Skipping ${tokenName} — exit tasks already finished`);
        continue;
      }

      const position = addPosition(tokenContract, pair, tokenName, entryPriceUsd, sizeSol);
      if (!position) {
        console.log(`[Recovery] Skipping ${tokenName} — addPosition failed`);
        continue;
      }

      trackToken(tokenContract, pair);

      storeAddPosition({
        orderId: trade.id,
        pair,
        token: tokenContract,
        tokenName,
        entryPriceUsd,
        sizeSol,
        status: "open",
        openedAt: trade.createAt || Date.now(),
      });

      console.log(`[Recovery] Recovered position from API: ${tokenName} @ ${entryPriceUsd}`);
    }
  } catch (err) {
    console.error("[Recovery] Error during recovery:", err);
  }
}

async function findActiveExits(sourceId: string): Promise<PnlOrder[]> {
  try {
    const response = await botHttp.get<PnlOrdersResponse>(
      `/automation/pnl_orders_from_swap_order?page=0&size=${CONFIG.recoveryFetchPageSize}&chain=solana&sourceId=${sourceId}`,
    );
    return response.err ? [] : response.res;
  } catch (err) {
    console.warn(`[Recovery] Failed to fetch active exits for ${sourceId}:`, err);
    return [];
  }
}
