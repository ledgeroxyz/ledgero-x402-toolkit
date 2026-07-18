import { X402ToolkitError } from "./errors.js";

/** Configuration for a `RateLimiter`. */
export interface RateLimiterOptions {
  /** Sustained rate at which tokens (permitted requests) are replenished, per second. Must be > 0. */
  ratePerSecond: number;
  /** Bucket capacity — the largest burst of requests allowed back-to-back. Defaults to `ratePerSecond`. */
  burst?: number;
  /**
   * What happens when `acquire()` is called with no token immediately available:
   * - `"queue"` (default): wait until a token becomes available.
   * - `"reject"`: throw `RateLimitExceededError` immediately, without waiting.
   */
  onLimitExceeded?: "queue" | "reject";
  /** Injectable clock, mainly for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable sleep, mainly for tests. Defaults to a real `setTimeout`-based wait. */
  sleep?: (ms: number) => Promise<void>;
}

/** Thrown by `RateLimiter#acquire` in `"reject"` mode when no token is immediately available. */
export class RateLimitExceededError extends X402ToolkitError {
  constructor(message = 'Rate limit exceeded; no token available and onLimitExceeded is "reject".') {
    super(message);
    this.name = "RateLimitExceededError";
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A simple token-bucket rate limiter. Tokens refill continuously at
 * `ratePerSecond`, up to a maximum of `burst` (the bucket's capacity). Each
 * call to `acquire()` consumes one token, either waiting for one to become
 * available (`"queue"` mode) or throwing immediately if none is available
 * (`"reject"` mode).
 *
 * Framework- and transport-agnostic and dependency-free — usable
 * standalone, or wired into `X402Client` via `X402ClientOptions#rateLimiter`
 * to cap outbound request rate per resource/provider.
 */
export class RateLimiter {
  private readonly ratePerSecond: number;
  private readonly capacity: number;
  private readonly mode: "queue" | "reject";
  private readonly clock: () => number;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  private tokens: number;
  private lastRefill: number;

  constructor(options: RateLimiterOptions) {
    if (!(options.ratePerSecond > 0)) {
      throw new X402ToolkitError("RateLimiter requires ratePerSecond > 0.");
    }
    if (options.burst !== undefined && !(options.burst > 0)) {
      throw new X402ToolkitError("RateLimiter requires burst > 0 when provided.");
    }

    this.ratePerSecond = options.ratePerSecond;
    this.capacity = options.burst ?? options.ratePerSecond;
    this.mode = options.onLimitExceeded ?? "queue";
    this.clock = options.now ?? Date.now;
    this.sleepImpl = options.sleep ?? defaultSleep;

    this.tokens = this.capacity;
    this.lastRefill = this.clock();
  }

  private refill(): void {
    const now = this.clock();
    const elapsedSeconds = Math.max(0, now - this.lastRefill) / 1000;
    if (elapsedSeconds > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.ratePerSecond);
      this.lastRefill = now;
    }
  }

  /**
   * Non-blocking: takes a token immediately if one is available, without
   * waiting or throwing. Returns whether it succeeded.
   */
  tryAcquire(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /**
   * Takes one token, per this limiter's configured `onLimitExceeded` mode:
   * - `"queue"`: resolves once a token becomes available (may wait).
   * - `"reject"`: resolves immediately if a token was available, otherwise
   *   rejects with `RateLimitExceededError` without waiting.
   */
  async acquire(): Promise<void> {
    if (this.tryAcquire()) return;

    if (this.mode === "reject") {
      throw new RateLimitExceededError();
    }

    while (!this.tryAcquire()) {
      const deficit = Math.max(0, 1 - this.tokens);
      const waitMs = Math.max(1, Math.ceil((deficit / this.ratePerSecond) * 1000));
      await this.sleepImpl(waitMs);
    }
  }

  /** Tokens currently available (after applying refill since the last check). Mainly for diagnostics/tests. */
  get availableTokens(): number {
    this.refill();
    return this.tokens;
  }
}

/**
 * A `RateLimiter`, or a factory that lazily creates one PER resource key
 * (e.g. per resource URL/provider) so different resources don't share one
 * bucket. Used by `X402ClientOptions#rateLimiter`: pass a single
 * `RateLimiter` instance to cap all outbound requests through one client
 * together, or a factory to cap each resource independently.
 */
export type RateLimiterProvider = RateLimiter | ((resourceKey: string) => RateLimiter);
