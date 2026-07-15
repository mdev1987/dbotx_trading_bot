import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, openSync, fsyncSync, closeSync } from "fs";
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

function tmpPath(): string {
  return filePath + ".tmp";
}

const MAX_STORED_ORDERS = 5000;

function flush(): void {
  const tmp = tmpPath();
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  try {
    const fd = openSync(tmp, "r");
    fsyncSync(fd);
    closeSync(fd);
  } catch { /* best-effort fsync */ }
  renameSync(tmp, filePath);
}

function capOrders(): void {
  if (data.orders.length > MAX_STORED_ORDERS) {
    data.orders = data.orders.slice(-MAX_STORED_ORDERS);
    flush();
  }
}

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

export function addOrder(order: StoredOrder): void {
  data.orders.push(order);
  capOrders();
  flush();
}

export function addPosition(pos: StoredPosition): void {
  const existing = data.positions.findIndex((p) => p.pair === pos.pair && p.status === "open");
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
  pos.pnl = pos.entryPriceUsd > 0 ? (exitPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd : 0;
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
