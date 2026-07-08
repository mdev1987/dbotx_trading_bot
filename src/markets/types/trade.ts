export type TradeSide = "buy" | "sell";

export type TradeStatus = "submitted" | "success" | "failed";

export interface BuyRequest {
  walletId: string;

  pair: string;

  amount: number;

  slippage: number;

  priorityFee?: number;

  jitoTip?: number;

  takeProfitPercent?: number;

  stopLossPercent?: number;

  trailingTriggerPercent?: number;

  trailingDistancePercent?: number;
}

export interface SellRequest {
  walletId: string;

  pair: string;

  percent: number;

  slippage: number;

  priorityFee?: number;

  jitoTip?: number;
}

export interface TradeResult {
  orderId: string;

  side: TradeSide;

  status: TradeStatus;

  txHash?: string;

  message?: string;

  timestamp: number;
}

export interface TradeAlert {
  event:
    | "buy_success"
    | "buy_failed"
    | "sell_success"
    | "sell_failed"
    | "tp_triggered"
    | "sl_triggered"
    | "trailing_triggered";

  orderId: string;

  pair: string;

  txHash?: string;

  timestamp: number;
}
