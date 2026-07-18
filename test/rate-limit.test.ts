import { describe, expect, it, vi } from "vitest";
import {
  createX402Client,
  RateLimitExceededError,
  RateLimiter,
  type PaymentPayload,
  type PaymentRequirements,
  type PaymentSigner,
  type SignContext,
} from "../src/index.js";

/** A fake clock, so token-bucket refill math is deterministic without waiting on real time. */
function makeClock(startAt = 0) {
  let current = startAt;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

class StubSigner implements PaymentSigner {
  async sign(requirements: PaymentRequirements, context: SignContext): Promise<PaymentPayload> {
    return {
      x402Version: context.x402Version,
      scheme: requirements.scheme,
      network: requirements.network,
      payload: {},
    };
  }
}

describe("RateLimiter", () => {
  it("allows a burst up to capacity, then throttles tryAcquire until tokens refill", () => {
    const clock = makeClock();
    const limiter = new RateLimiter({ ratePerSecond: 5, burst: 3, now: clock.now });

    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false); // burst exhausted

    clock.advance(1000); // 1s at 5/s -> 5 tokens, capped at burst 3
    expect(limiter.availableTokens).toBe(3);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
  });

  it("refills gradually, not all at once", () => {
    const clock = makeClock();
    const limiter = new RateLimiter({ ratePerSecond: 10, burst: 1, now: clock.now });

    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);

    clock.advance(50); // 0.05s * 10/s = 0.5 tokens -> still not enough
    expect(limiter.tryAcquire()).toBe(false);

    clock.advance(50); // total 100ms = 1 full token
    expect(limiter.tryAcquire()).toBe(true);
  });

  it("defaults burst to ratePerSecond when not provided", () => {
    const clock = makeClock();
    const limiter = new RateLimiter({ ratePerSecond: 2, now: clock.now });
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
  });

  it('in "queue" mode, acquire() waits (via injected sleep) until a token is available, then drains', async () => {
    const clock = makeClock();
    const sleepCalls: number[] = [];
    const sleep = async (ms: number) => {
      sleepCalls.push(ms);
      clock.advance(ms);
    };

    const limiter = new RateLimiter({
      ratePerSecond: 10,
      burst: 2,
      onLimitExceeded: "queue",
      now: clock.now,
      sleep,
    });

    await limiter.acquire(); // immediate (burst)
    await limiter.acquire(); // immediate (burst)

    // Third call has no token available -> must wait for a refill via the injected sleep.
    await limiter.acquire();

    expect(sleepCalls.length).toBeGreaterThan(0);
    expect(sleepCalls.every((ms) => ms > 0)).toBe(true);
  });

  it('in "reject" mode, acquire() throws RateLimitExceededError immediately with no wait', async () => {
    const clock = makeClock();
    const sleep = vi.fn(async () => {});
    const limiter = new RateLimiter({ ratePerSecond: 10, burst: 1, onLimitExceeded: "reject", now: clock.now, sleep });

    await expect(limiter.acquire()).resolves.toBeUndefined(); // consumes the only token
    await expect(limiter.acquire()).rejects.toThrow(RateLimitExceededError);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("rejects a non-positive ratePerSecond", () => {
    expect(() => new RateLimiter({ ratePerSecond: 0 })).toThrow(/ratePerSecond/);
    expect(() => new RateLimiter({ ratePerSecond: -1 })).toThrow(/ratePerSecond/);
  });
});

describe("X402Client + rateLimiter wiring", () => {
  it("rejects a request immediately when the client's rate limiter is exhausted in reject mode", async () => {
    const clock = makeClock();
    const rateLimiter = new RateLimiter({ ratePerSecond: 1, burst: 1, onLimitExceeded: "reject", now: clock.now });

    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const client = createX402Client({ fetch: fetchMock, signer: new StubSigner(), rateLimiter });

    const first = await client.request("https://api.example/v1/resource");
    expect(first.status).toBe(200);

    await expect(client.request("https://api.example/v1/resource")).rejects.toThrow(RateLimitExceededError);
    expect(fetchMock).toHaveBeenCalledTimes(1); // second call never reached fetch
  });

  it("gives each resource its own bucket when rateLimiter is a per-resource factory", async () => {
    const clock = makeClock();
    const created: string[] = [];
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const client = createX402Client({
      fetch: fetchMock,
      signer: new StubSigner(),
      rateLimiter: (resourceKey: string) => {
        created.push(resourceKey);
        return new RateLimiter({ ratePerSecond: 1, burst: 1, onLimitExceeded: "reject", now: clock.now });
      },
    });

    // Different resources -> independent buckets -> both succeed even though each bucket only holds 1.
    const a = await client.request("https://provider-a.example/v1/resource");
    const b = await client.request("https://provider-b.example/v1/resource");
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    // Same resource again -> shares the already-exhausted bucket -> rejected.
    await expect(client.request("https://provider-a.example/v1/resource")).rejects.toThrow(RateLimitExceededError);

    expect(created).toEqual(["https://provider-a.example/v1/resource", "https://provider-b.example/v1/resource"]);
  });
});
