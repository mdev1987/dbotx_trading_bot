/**
 * Reusable HTTP client with retry, exponential backoff, and jitter.
 *
 * This is a standalone implementation that does NOT import from the simulator
 * module.  It mirrors the retry logic used in the simulator but is maintained
 * independently to decouple the live module.
 */
import { LIVE_CONFIG } from "./config";

/**
 * Idempotent HTTP methods that are safe to retry automatically.
 */
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);

export interface FetchRetryOptions {
  /** Maximum number of retry attempts. */
  retries?: number;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
  /** Base delay in ms for exponential backoff. */
  baseDelayMs?: number;
  /** Set true to force retry even for non-idempotent methods (e.g., POST). */
  retryNonIdempotent?: boolean;
}

/**
 * Sleep for the given duration.
 * @param ms - Milliseconds to wait.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check whether an HTTP status code indicates a retryable failure.
 * @param status - HTTP status code.
 * @returns True if the request should be retried.
 */
function isRetryableStatus(status: number): boolean {
  return [429, 500, 502, 503, 504].includes(status);
}

/**
 * Compute exponential backoff with random jitter.
 * Attempt 0 → ~500–1500 ms, attempt 1 → ~1000–3000 ms, etc.
 * @param attempt - Zero-based attempt number.
 * @param baseDelay - Base delay in milliseconds.
 * @returns Delay in milliseconds.
 */
function calculateBackoff(attempt: number, baseDelay: number): number {
  const exponential = baseDelay * 2 ** attempt;
  const jitter = 0.5 + Math.random();
  return Math.floor(exponential * jitter);
}

/**
 * Execute an HTTP request with timeout, retry, and exponential backoff.
 *
 * Retries are performed for:
 *   • Network errors
 *   • Request timeouts
 *   • HTTP 429 (rate limit)
 *   • HTTP 5xx (server errors)
 *
 * By default only idempotent methods are retried.  Pass `retryNonIdempotent: true`
 * to force retry for POST, PATCH, etc.
 *
 * @param url - Request URL.
 * @param init - Fetch options (method, headers, body, etc.).
 * @param options - Retry configuration overrides.
 * @returns The Response object on success.
 * @throws Error when all attempts fail.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  options: FetchRetryOptions = {},
): Promise<Response> {
  /** Resolve config from caller options or global defaults. */
  const maxRetries = options.retries ?? LIVE_CONFIG.httpMaxRetries;
  const timeoutMs = options.timeoutMs ?? LIVE_CONFIG.httpTimeoutMs;
  const baseDelayMs = options.baseDelayMs ?? LIVE_CONFIG.httpBaseDelayMs;

  /** Normalise the HTTP method. */
  const method = (init.method ?? "GET").toUpperCase();

  /** Determine whether retry is allowed for this method. */
  const retryAllowed =
    IDEMPOTENT_METHODS.has(method) || options.retryNonIdempotent === true;

  /** Track the last error to surface when all retries are exhausted. */
  let lastError: Error | undefined;

  /** Retry loop: attempt 0 is the first try. */
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    /** Create a fresh AbortController per attempt. */
    const controller = new AbortController();
    /** Schedule an abort on timeout. */
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });

      /** Fast path: successful response. */
      if (response.ok) {
        return response;
      }

      /** Check if we should retry this status. */
      if (
        retryAllowed &&
        attempt < maxRetries &&
        isRetryableStatus(response.status)
      ) {
        /** Honour Retry-After header if present. */
        const retryAfter = Number(response.headers.get("Retry-After")) || null;
        const delayMs =
          retryAfter !== null
            ? retryAfter * 1000
            : calculateBackoff(attempt, baseDelayMs);

        console.warn(
          `[live/http] ${response.status} ${method} ${url} -> retry in ${delayMs}ms`,
        );
        await sleep(delayMs);
        continue;
      }

      /** Non-retryable status or no retries left. */
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    } catch (error) {
      /** Distinguish AbortController timeout from other errors. */
      if (error instanceof DOMException && error.name === "AbortError") {
        lastError = new Error(`Request timeout after ${timeoutMs}ms`);
      } else {
        lastError = error instanceof Error ? error : new Error(String(error));
      }

      if (retryAllowed && attempt < maxRetries) {
        const delayMs = calculateBackoff(attempt, baseDelayMs);
        console.warn(`[live/http] ${lastError.message} -> retry in ${delayMs}ms`);
        await sleep(delayMs);
        continue;
      }

      throw lastError;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Safety net: loop should always throw or return. */
  throw lastError ?? new Error("Request failed without a specific error");
}

/**
 * Helper: perform a GET request and parse JSON, with retry.
 * Wraps fetchWithRetry for the common READ pattern.
 *
 * @param url - Request URL.
 * @param options - Retry configuration overrides.
 * @returns Parsed JSON body.
 */
export async function getJson<T>(
  url: string,
  options: FetchRetryOptions = {},
): Promise<T> {
  const response = await fetchWithRetry(url, {
    method: "GET",
    headers: { "x-api-key": LIVE_CONFIG.dbotxApiKey },
  }, options);
  return response.json() as Promise<T>;
}

/**
 * Helper: perform a POST request with JSON body and parse JSON response, with retry.
 * Non-idempotent retry is enabled by default for resilience.
 *
 * @param url - Request URL.
 * @param body - JSON-serializable request body.
 * @param options - Retry configuration overrides.
 * @returns Parsed JSON response.
 */
export async function postJson<T>(
  url: string,
  body: unknown,
  options: FetchRetryOptions = {},
): Promise<T> {
  const response = await fetchWithRetry(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": LIVE_CONFIG.dbotxApiKey,
    },
    body: JSON.stringify(body),
  }, {
    ...options,
    retryNonIdempotent: options.retryNonIdempotent ?? true,
  });
  return response.json() as Promise<T>;
}
