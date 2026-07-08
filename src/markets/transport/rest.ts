import { retry, type RetryOptions } from "./retry";

export interface RestClientOptions {
  baseUrl: string;
  apiKey: string;
  retry?: Partial<RetryOptions>;
}

export class RestClient {
  constructor(private readonly options: RestClientOptions) {}

  get<T>(path: string, init?: RequestInit): Promise<T> {
    return this.request<T>("GET", path, undefined, init);
  }

  post<T>(path: string, body?: unknown, init?: RequestInit): Promise<T> {
    return this.request<T>("POST", path, body, init);
  }

  put<T>(path: string, body?: unknown, init?: RequestInit): Promise<T> {
    return this.request<T>("PUT", path, body, init);
  }

  delete<T>(path: string, init?: RequestInit): Promise<T> {
    return this.request<T>("DELETE", path, undefined, init);
  }

  request<T>(
    method: string,
    path: string,
    body?: unknown,
    init?: RequestInit,
  ): Promise<T> {
    return retry(async () => {
      const response = await fetch(`${this.options.baseUrl}${path}`, {
        ...init,
        method,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.options.apiKey,
          ...init?.headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }

      return (await response.json()) as T;
    }, this.options.retry);
  }
}
