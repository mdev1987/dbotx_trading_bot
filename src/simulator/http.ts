/**
 * simulator/http.ts
 *
 * Shared HTTP utilities for simulator API calls.
 *
 * - fetchWithRetry: fetch with timeout, exponential backoff, and
 *   retry on 429/5xx status codes.
 */

const MAX_RETRIES = 4;
const BASE_DELAY_MS = 1_000;
const TIMEOUT_MS = 30_000;

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryable(status: number): boolean {
  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });

      if (response.ok) return response;

      if (isRetryable(response.status) && attempt < MAX_RETRIES) {
        const backoff = BASE_DELAY_MS * 2 ** attempt;
        console.warn(
          `[http] HTTP ${response.status} on ${url.slice(0, 60)} — retry ${attempt + 1}/${MAX_RETRIES} in ${backoff}ms`,
        );
        await delay(backoff);
        continue;
      }

      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        lastError = new Error(`Request timed out after ${TIMEOUT_MS}ms`);
      } else {
        lastError = err instanceof Error ? err : new Error(String(err));
      }

      if (attempt < MAX_RETRIES) {
        const backoff = BASE_DELAY_MS * 2 ** attempt;
        console.warn(
          `[http] ${lastError.message} — retry ${attempt + 1}/${MAX_RETRIES} in ${backoff}ms`,
        );
        await delay(backoff);
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new Error("Request failed after retries");
}
