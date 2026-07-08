// REST is only fallback.

import type { TradeStatus } from "./trade";

export interface ApiResponse<T> {
  success: boolean;

  data: T;
}

export interface OrderInfo {
  orderId: string;

  status: TradeStatus;

  txHash?: string;
}
