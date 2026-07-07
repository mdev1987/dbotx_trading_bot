const enum ErrorCode {
  ConfigMissing = "CONFIG_MISSING",
  ApiFailure = "API_FAILURE",
  OrderRejected = "ORDER_REJECTED",
  OrderTimeout = "ORDER_TIMEOUT",
  PositionNotFound = "POSITION_NOT_FOUND",
  DuplicateBuy = "DUPLICATE_BUY",
  DailyLossLimit = "DAILY_LOSS_LIMIT",
  RateLimited = "RATE_LIMITED",
  PanicMode = "PANIC_MODE",
  Cooldown = "COOLDOWN_ACTIVE",
  WalletMismatch = "WALLET_MISMATCH",
}

export class TradingError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "TradingError";
  }
}

export function configError(key: string): TradingError {
  return new TradingError(
    `Missing required environment variable: ${key}`,
    ErrorCode.ConfigMissing,
    { key },
  );
}

export function apiError(endpoint: string, detail: string): TradingError {
  return new TradingError(
    `API error [${endpoint}]: ${detail}`,
    ErrorCode.ApiFailure,
    { endpoint, detail },
  );
}

export function orderRejectedError(pair: string, direction: string): TradingError {
  return new TradingError(
    `${direction} order rejected for ${pair}`,
    ErrorCode.OrderRejected,
    { pair, direction },
  );
}

export function orderTimeoutError(orderId: string): TradingError {
  return new TradingError(
    `Order ${orderId} did not complete in time`,
    ErrorCode.OrderTimeout,
    { orderId },
  );
}

export function positionNotFoundError(id: number): TradingError {
  return new TradingError(
    `Position ${id} not found`,
    ErrorCode.PositionNotFound,
    { positionId: id },
  );
}
