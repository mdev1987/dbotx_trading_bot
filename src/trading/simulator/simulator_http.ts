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
            throw new Error(
              `[Simulator] ${method} ${path} failed (${response.status})`,
            );
          }

          return (await response.json()) as T;
        } finally {
          clearTimeout(timeout);
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < CONFIG.httpMaxRetries) {
          console.warn(
            `[Simulator] ${method} ${path} attempt ${attempt + 1}/${CONFIG.httpMaxRetries + 1} failed: ${lastError.message}. Retrying...`,
          );
        }
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
