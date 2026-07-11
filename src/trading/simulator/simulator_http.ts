import { CONFIG } from "../../config";

/* -------------------------------------------------------------------------- */
/*                              HTTP Configuration                            */
/* -------------------------------------------------------------------------- */

const BASE_URL = "https://api-bot-v1.dbotx.com";

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
    const response = await fetch(`${BASE_URL}${path}`, {
      method,

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
  }
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
