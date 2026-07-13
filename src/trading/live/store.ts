import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";

export interface StoredOrder {
  id: string;
  type: "buy" | "sell";
  pair: string;
  token: string;
  tokenName: string;
  amountSol: number;
  createdAt: number;
}

export interface StoredPosition {
  orderId: string;
  pair: string;
  token: string;
  tokenName: string;
  entryPriceUsd: number;
  sizeSol: number;
  status: "open" | "closed";
  openedAt: number;
  closedAt?: number;
  exitPriceUsd?: number;
  pnl?: number;
  reason?: string;
}

interface StoreData {
  orders: StoredOrder[];
  positions: StoredPosition[];
}

const DEFAULT_DATA: StoreData = { orders: [], positions: [] };

let data: StoreData;
let filePath: string;

export function initLiveStore(path: string): void {
  filePath = path;
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  if (existsSync(filePath)) {
    try {
      data = JSON.parse(readFileSync(filePath, "utf-8"));
    } catch {
      data = { ...DEFAULT_DATA, orders: [], positions: [] };
    }
  } else {
    data = { ...DEFAULT_DATA, orders: [], positions: [] };
    flush();
  }
}

function flush(): void {
  writeFileSync(filePath, JSON.stringify(data, null, 2));
}

export function addOrder(order: StoredOrder): void {
  data.orders.push(order);
  flush();
}

export function addPosition(pos: StoredPosition): void {
  const existing = data.positions.findIndex((p) => p.pair === pos.pair);
  if (existing >= 0) {
    data.positions[existing] = pos;
  } else {
    data.positions.push(pos);
  }
  flush();
}

export function closePosition(pair: string, exitPriceUsd: number, reason: string): void {
  const pos = data.positions.find((p) => p.pair === pair && p.status === "open");
  if (!pos) return;
  pos.status = "closed";
  pos.closedAt = Date.now();
  pos.exitPriceUsd = exitPriceUsd;
  pos.pnl = (exitPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd;
  pos.reason = reason;
  flush();
}

export function getStoreOrders(): readonly StoredOrder[] {
  return data.orders;
}

export function getStoreOpenPositions(): StoredPosition[] {
  return data.positions.filter((p) => p.status === "open");
}

export function updateOrderMeta(orderId: string, meta: Partial<Pick<StoredOrder, "token" | "tokenName">>): void {
  const order = data.orders.find((o) => o.id === orderId);
  if (!order) return;
  if (meta.token !== undefined) order.token = meta.token;
  if (meta.tokenName !== undefined) order.tokenName = meta.tokenName;
  flush();
}
