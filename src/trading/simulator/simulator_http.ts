import { CONFIG } from "../../config";

/* -------------------------------------------------------------------------- */
/*                                HTTP Client                                 */
/* -------------------------------------------------------------------------- */

class SimulatorHttpClient {
  /* ------------------------------------------------------------------------ */
  /*                                  GET                                     */
  /* ------------------------------------------------------------------------ */

  async get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  /* ------------------------------------------------------------------------ */
  /*                                  POST                                    */
  /* ------------------------------------------------------------------------ */

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  /* ------------------------------------------------------------------------ */
  /*                                 Request                                  */
  /* ------------------------------------------------------------------------ */

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= CONFIG.httpMaxRetries; attempt++) {
      if (attempt > 0) {
        await sleep(CONFIG.httpBaseDelayMs * 2 ** (attempt - 1));
      }

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), CONFIG.httpTimeoutMs);

        try {
          const response = await fetch(`${CONFIG.baseUrl}${path}`, {
            method,
            signal: controller.signal,
            headers: {
              "Content-Type": "application/json",
              "x-api-key": CONFIG.dbotxApiKey,
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          });

          if (!response.ok) {
            const error = new Error(
              `[Simulator] ${method} ${path} failed (${response.status})`,
            );
            if (response.status >= 400 && response.status < 500) {
              error.name = "NonRetryableError";
            }
            throw error;
          }

          return (await response.json()) as T;
        } finally {
          clearTimeout(timeout);
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (lastError.name === "NonRetryableError" || attempt >= CONFIG.httpMaxRetries) {
          throw lastError;
        }

        console.warn(
          `[Simulator] ${method} ${path} attempt ${attempt + 1}/${CONFIG.httpMaxRetries + 1} failed: ${lastError.message}. Retrying...`,
        );
      }
    }

    throw lastError ?? new Error(`[Simulator] ${method} ${path} failed`);
  }
}

/* -------------------------------------------------------------------------- */
/*                                   Helper                                   */
/* -------------------------------------------------------------------------- */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* -------------------------------------------------------------------------- */
/*                              Shared Instance                               */
/* -------------------------------------------------------------------------- */

/**
 * Shared simulator HTTP client.
 *
 * Reused across:
 *
 * - simulator_account.ts
 * - simulator_orders.ts
 * - simulator_tasks.ts
 */
export const http = new SimulatorHttpClient();
