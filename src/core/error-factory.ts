/** Internal error code constants used to categorize TradingError instances */
const enum ErrorCode {
  ConfigMissing = "CONFIG_MISSING", // Missing environment variable
  ApiFailure = "API_FAILURE", // External API call failed
  OrderRejected = "ORDER_REJECTED", // Exchange rejected the order
  OrderTimeout = "ORDER_TIMEOUT", // Order did not fill in time
  PositionNotFound = "POSITION_NOT_FOUND", // Referenced position does not exist
  DuplicateBuy = "DUPLICATE_BUY", // Attempted duplicate purchase
  DailyLossLimit = "DAILY_LOSS_LIMIT", // Daily loss cap reached
  RateLimited = "RATE_LIMITED", // Buy rate limit exceeded
  PanicMode = "PANIC_MODE", // System entered panic mode
  Cooldown = "COOLDOWN_ACTIVE", // Trading paused due to cooldown
  WalletMismatch = "WALLET_MISMATCH", // Wallet address does not match expected
}

/** Custom error class for trading-related failures, carrying a code and optional context */
export class TradingError extends Error {
  constructor(
    message: string, // Human-readable error message
    public readonly code: string, // Machine-readable error code
    public readonly context?: Record<string, unknown>, // Additional structured context
  ) {
    super(message);
    this.name = "TradingError"; // Override the default Error name
  }
}

/** Create a TradingError for a missing configuration/environment variable */
export function configError(key: string): TradingError {
  return new TradingError(
    `Missing required environment variable: ${key}`,
    ErrorCode.ConfigMissing,
    { key }, // Context includes which key was missing
  );
}

/** Create a TradingError for an external API failure */
export function apiError(endpoint: string, detail: string): TradingError {
  return new TradingError(
    `API error [${endpoint}]: ${detail}`,
    ErrorCode.ApiFailure,
    { endpoint, detail }, // Context includes endpoint and error detail
  );
}

/** Create a TradingError for a rejected order (buy/sell) */
export function orderRejectedError(pair: string, direction: string): TradingError {
  return new TradingError(
    `${direction} order rejected for ${pair}`,
    ErrorCode.OrderRejected,
    { pair, direction }, // Context includes pair and direction (buy/sell)
  );
}

/** Create a TradingError for an order that did not complete within the expected time */
export function orderTimeoutError(orderId: string): TradingError {
  return new TradingError(
    `Order ${orderId} did not complete in time`,
    ErrorCode.OrderTimeout,
    { orderId }, // Context includes the order ID that timed out
  );
}

/** Create a TradingError when a position ID cannot be found in the store */
export function positionNotFoundError(id: number): TradingError {
  return new TradingError(
    `Position ${id} not found`,
    ErrorCode.PositionNotFound,
    { positionId: id }, // Context includes the missing position ID
  );
}
