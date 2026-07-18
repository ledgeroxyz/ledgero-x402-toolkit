/**
 * Retry/backoff for TRANSIENT failures only — network errors and 5xx
 * responses. This is deliberately separate from the 402 payment flow: a 402
 * is a signal to pay, not a transient failure, so it is never retried here.
 */
export interface RetryOptions {
  /** Total attempts, including the first. Defaults to 3. */
  maxAttempts?: number;
  /** Base delay before the first retry, in milliseconds. Defaults to 200. */
  baseDelayMs?: number;
  /** Delay is capped at this many milliseconds. Defaults to 5000. */
  maxDelayMs?: number;
  /** Multiplier applied to the delay after each attempt. Defaults to 2. */
  factor?: number;
  /** Randomize each delay within [50%, 100%] of its computed value. Defaults to true. */
  jitter?: boolean;
  /** Override what counts as retryable. Defaults to: any thrown error, or a 5xx response. */
  shouldRetry?: (attempt: number, error: unknown, response: Response | undefined) => boolean;
  /** Called before each wait, with the attempt number (1-based) that just failed and the delay about to be used. */
  onRetry?: (attempt: number, delayMs: number, reason: unknown) => void;
  /** Injectable sleep, mainly for tests. Defaults to a real `setTimeout`-based wait. */
  sleep?: (ms: number) => Promise<void>;
}

type NormalizedRetryOptions = Required<
  Pick<RetryOptions, "maxAttempts" | "baseDelayMs" | "maxDelayMs" | "factor" | "jitter">
>;

export const DEFAULT_RETRY_OPTIONS: NormalizedRetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 5000,
  factor: 2,
  jitter: true,
};

function defaultShouldRetry(_attempt: number, error: unknown, response: Response | undefined): boolean {
  if (error !== undefined) return true;
  if (response && response.status >= 500 && response.status <= 599) return true;
  return false;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeDelay(attempt: number, options: NormalizedRetryOptions): number {
  const raw = Math.min(options.maxDelayMs, options.baseDelayMs * options.factor ** (attempt - 1));
  if (!options.jitter) return raw;
  return Math.round(raw * (0.5 + Math.random() * 0.5));
}

/**
 * Runs `fn`, retrying with exponential backoff on transient failures
 * (thrown errors, or a 5xx `Response`). Any other response (including 402,
 * and other 4xx statuses) is returned immediately without retrying.
 */
export async function withRetry<T extends Response>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const merged: NormalizedRetryOptions = { ...DEFAULT_RETRY_OPTIONS, ...options };
  const shouldRetry = options.shouldRetry ?? defaultShouldRetry;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;

  for (let attempt = 1; attempt <= merged.maxAttempts; attempt++) {
    try {
      const response = await fn();
      const isLastAttempt = attempt === merged.maxAttempts;
      if (isLastAttempt || !shouldRetry(attempt, undefined, response)) {
        return response;
      }
      const delay = computeDelay(attempt, merged);
      options.onRetry?.(attempt, delay, response);
      await sleep(delay);
    } catch (error) {
      lastError = error;
      const isLastAttempt = attempt === merged.maxAttempts;
      if (isLastAttempt || !shouldRetry(attempt, error, undefined)) {
        throw error;
      }
      const delay = computeDelay(attempt, merged);
      options.onRetry?.(attempt, delay, error);
      await sleep(delay);
    }
  }

  // Unreachable: the loop above always returns or throws by the last attempt.
  throw lastError ?? new Error("withRetry: exhausted attempts without a result");
}
