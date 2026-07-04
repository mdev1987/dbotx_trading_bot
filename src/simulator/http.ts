import { CONFIG } from "../config";

/**
 * Safe methods that may be retried automatically.
 */
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface FetchRetryOptions {
  retries?: number;
  timeoutMs?: number;
  baseDelayMs?: number;
  retryNonIdempotent?: boolean;
}

/**
 * Sleep helper.
 *
 * @param ms Delay in milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Returns true if an HTTP response should be retried.
 *
 * @param status HTTP status code.
 */
function isRetryableStatus(status: number): boolean {
  return [429, 500, 502, 503, 504].includes(status);
}

/**
 * Generate exponential backoff with jitter.
 *
 * Examples:
 *
 * attempt 0 -> ~500-1500ms
 * attempt 1 -> ~1000-3000ms
 * attempt 2 -> ~2000-6000ms
 */
function calculateBackoff(attempt: number, baseDelay: number): number {
  const exponential = baseDelay * 2 ** attempt;

  const jitter = 0.5 + Math.random();

  return Math.floor(exponential * jitter);
}

/**
 * Execute fetch with timeout and retry support.
 *
 * Retries are performed for:
 *
 * - network failures
 * - request timeouts
 * - HTTP 429
 * - HTTP 5xx
 *
 * By default only idempotent methods are retried.
 *
 * @param url Request URL.
 * @param init Fetch options.
 * @param options Retry configuration.
 *
 * @throws Error when all attempts fail.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  options: FetchRetryOptions = {},
): Promise<Response> {
  // Resolve retry config — caller option takes precedence, fall back to global defaults
  const retries = options.retries ?? CONFIG.httpMaxRetries;
  const timeoutMs = options.timeoutMs ?? CONFIG.httpTimeoutMs;
  const baseDelayMs = options.baseDelayMs ?? CONFIG.httpBaseDelayMs;

  // Normalise the HTTP method so retry logic can check idempotency
  const method = (init.method ?? "GET").toUpperCase();

  // Only retry idempotent methods by default (GET, HEAD, OPTIONS);
  // caller can force retry for non-idempotent via retryNonIdempotent flag
  const retryAllowed =
    IDEMPOTENT_METHODS.has(method) || options.retryNonIdempotent === true;

  // Track the last error so it can be surfaced when all retries are exhausted
  let lastError: Error | undefined;

  // Retry loop: attempt 0 is the first try, attempt N is the (N+1)-th try
  for (let attempt = 0; attempt <= retries; attempt++) {
    // Create a fresh AbortController per attempt so timeouts are independent
    const controller = new AbortController();

    // Schedule an abort after the configured timeout
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // Perform the actual HTTP request with the abort signal attached
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });

      // Fast path: successful response returned immediately
      if (response.ok) {
        return response;
      }

      // Check if retry is allowed AND we have attempts left AND the status is retryable
      if (
        retryAllowed &&
        attempt < retries &&
        isRetryableStatus(response.status)
      ) {
        // Honour the server's Retry-After header if present, otherwise use backoff
        const retryAfter = Number(response.headers.get("Retry-After")) || null;

        // Calculate delay: server-suggested (seconds → ms) or exponential backoff with jitter
        const delayMs =
          retryAfter !== null
            ? retryAfter * 1000
            : calculateBackoff(attempt, baseDelayMs);

        console.warn(
          `[http] ${response.status} ${method} ${url} -> retry in ${delayMs}ms`,
        );

        // Wait for the backoff period before the next attempt
        await sleep(delayMs);

        // Jump to the next iteration of the retry loop
        continue;
      }

      // Non-retryable status or no retries left — fail immediately
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    } catch (error) {
      // Distinguish between a true network timeout (AbortController) and other errors
      if (error instanceof DOMException && error.name === "AbortError") {
        lastError = new Error(`Request timeout after ${timeoutMs}ms`);
      } else {
        // Normalise any thrown value into an Error instance
        lastError = error instanceof Error ? error : new Error(String(error));
      }

      // If retries remain, back off and try again
      if (retryAllowed && attempt < retries) {
        const delayMs = calculateBackoff(attempt, baseDelayMs);

        console.warn(`[http] ${lastError.message} -> retry in ${delayMs}ms`);

        // Wait for the backoff delay before looping
        await sleep(delayMs);

        // Continue to the next attempt
        continue;
      }

      // No retries left — rethrow the last captured error
      throw lastError;
    } finally {
      // Always clear the timeout timer so the controller isn't aborted after completion
      clearTimeout(timeout);
    }
  }

  // Safety net: if the loop exits without throwing, throw the last error (or a generic message)
  throw lastError ?? new Error("Request failed");
}
