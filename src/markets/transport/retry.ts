import { timer, firstValueFrom } from "rxjs";

export interface RetryOptions {
  retries: number;
  delay: number;
  maxDelay?: number;
  factor?: number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  retries: 3,
  delay: 500,
  maxDelay: 5000,
  factor: 2,
  shouldRetry: () => true,
};

export async function retry<T>(
  operation: () => Promise<T>,
  options: Partial<RetryOptions> = {},
): Promise<T> {
  const config = {
    ...DEFAULT_OPTIONS,
    ...options,
  };

  let attempt = 0;
  let delay = config.delay;

  while (true) {
    try {
      return await operation();
    } catch (error) {
      attempt++;

      if (attempt > config.retries || !config.shouldRetry(error, attempt)) {
        throw error;
      }

      await firstValueFrom(timer(delay));

      delay = Math.min(delay * config.factor, config.maxDelay);
    }
  }
}

export async function retryForever<T>(
  operation: () => Promise<T>,
  delay = 1000,
): Promise<T> {
  while (true) {
    try {
      return await operation();
    } catch {
      await firstValueFrom(timer(delay));
    }
  }
}
