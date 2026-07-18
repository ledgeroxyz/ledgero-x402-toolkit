import { describe, expect, it, vi } from "vitest";
import { withRetry } from "../src/index.js";

describe("withRetry", () => {
  it("retries transient 5xx responses with exponential backoff, then returns on success", async () => {
    const fn = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 502 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    const delays: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      delays.push(ms);
    });

    const response = await withRetry(fn, { maxAttempts: 5, baseDelayMs: 10, jitter: false, sleep });

    expect(response.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([10, 20]); // exponential backoff: base * factor^(attempt-1)
  });

  it("does not retry an HTTP 402 Payment Required response", async () => {
    const fn = vi.fn<() => Promise<Response>>().mockResolvedValue(new Response(null, { status: 402 }));
    const sleep = vi.fn(async () => {});

    const response = await withRetry(fn, { maxAttempts: 5, sleep });

    expect(response.status).toBe(402);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not retry ordinary 4xx client errors", async () => {
    const fn = vi.fn<() => Promise<Response>>().mockResolvedValue(new Response(null, { status: 404 }));
    const sleep = vi.fn(async () => {});

    const response = await withRetry(fn, { maxAttempts: 5, sleep });

    expect(response.status).toBe(404);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("throws after exhausting retries on persistent network errors", async () => {
    const error = new Error("ECONNRESET");
    const fn = vi.fn<() => Promise<Response>>().mockRejectedValue(error);
    const sleep = vi.fn(async () => {});

    await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 5, sleep })).rejects.toThrow("ECONNRESET");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("recovers from a transient network error before exhausting attempts", async () => {
    const fn = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValueOnce(new Error("network blip"))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const sleep = vi.fn(async () => {});

    const response = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 5, sleep });

    expect(response.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("honors a custom shouldRetry predicate", async () => {
    const fn = vi.fn<() => Promise<Response>>().mockResolvedValue(new Response(null, { status: 429 }));
    const sleep = vi.fn(async () => {});

    const response = await withRetry(fn, {
      maxAttempts: 3,
      sleep,
      shouldRetry: (_attempt, _error, response) => response?.status === 429,
    });

    expect(response.status).toBe(429);
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
