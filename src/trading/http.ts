import { CONFIG } from "../config";

class HttpClient {
  constructor(private readonly baseUrl: string) {}

  async get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

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
          const response = await fetch(`${this.baseUrl}${path}`, {
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
              `[HTTP] ${method} ${path} failed (${response.status})`,
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
          `[HTTP] ${method} ${path} attempt ${attempt + 1}/${CONFIG.httpMaxRetries + 1} failed: ${lastError.message}. Retrying...`,
        );
      }
    }

    throw lastError ?? new Error(`[HTTP] ${method} ${path} failed`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Simulator HTTP client (legacy baseUrl) */
export const simHttp = new HttpClient(CONFIG.baseUrl);

/** Bot API HTTP client (servapi) */
export const botHttp = new HttpClient(CONFIG.servapiBaseUrl);

/** Data API HTTP client (dataBaseUrl) */
export const dataHttp = new HttpClient(CONFIG.dataBaseUrl);
