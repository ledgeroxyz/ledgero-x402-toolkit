import { describe, expect, it, vi } from "vitest";
import {
  BudgetExceededError,
  createX402Client,
  InMemorySpendTracker,
  type PaymentPayload,
  type PaymentRequirements,
  type PaymentSigner,
  type SignContext,
} from "../src/index.js";

function make402Response(requirements: PaymentRequirements): Response {
  const body = {
    x402Version: 1,
    accepts: [requirements],
  };
  return new Response(JSON.stringify(body), {
    status: 402,
    headers: { "content-type": "application/json" },
  });
}

function makeRequirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: "base-sepolia",
    maxAmountRequired: "10000",
    resource: "https://api.ledgero.xyz/v1/underwriting/assess",
    payTo: "0xPayToAddress",
    asset: "0xUsdcAddress",
    description: "Per-assessment underwriting data lookup",
    ...overrides,
  };
}

class StubSigner implements PaymentSigner {
  public calls: Array<{ requirements: PaymentRequirements; context: SignContext }> = [];

  async sign(requirements: PaymentRequirements, context: SignContext): Promise<PaymentPayload> {
    this.calls.push({ requirements, context });
    return {
      x402Version: context.x402Version,
      scheme: requirements.scheme,
      network: requirements.network,
      payload: { signature: "0xdeadbeef", from: "0xAgentWallet" },
    };
  }
}

describe("X402Client", () => {
  it("retries the original request with an X-PAYMENT header after a 402", async () => {
    const requirements = makeRequirements();
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(make402Response(requirements));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const signer = new StubSigner();
    const client = createX402Client({ fetch: fetchMock, signer });

    const response = await client.request("https://api.ledgero.xyz/v1/underwriting/assess", { method: "POST" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(200);
    expect(response.x402?.paid).toBe(true);
    expect(response.x402?.reused).toBe(false);
    expect(signer.calls).toHaveLength(1);

    const secondCallInit = fetchMock.mock.calls[1]?.[1];
    const secondCallHeaders = new Headers(secondCallInit?.headers);
    expect(secondCallHeaders.get("X-PAYMENT")).toBeTruthy();

    const decoded = JSON.parse(Buffer.from(secondCallHeaders.get("X-PAYMENT")!, "base64").toString("utf-8"));
    expect(decoded).toMatchObject({ scheme: "exact", network: "base-sepolia" });
  });

  it("passes through non-402 responses untouched (no payment attempted)", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const signer = new StubSigner();
    const client = createX402Client({ fetch: fetchMock, signer });

    const response = await client.request("https://api.ledgero.xyz/v1/underwriting/assess");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.x402?.paid).toBe(false);
    expect(signer.calls).toHaveLength(0);
  });

  it("does not call the signer twice for retries sharing the same idempotency key", async () => {
    const requirements = makeRequirements();
    const fetchMock = vi.fn<typeof fetch>();
    // First logical attempt: 402 then 200.
    fetchMock.mockResolvedValueOnce(make402Response(requirements));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    // Second logical attempt — simulating the caller retrying the SAME
    // logical call (e.g. after a client crash before it saw the first
    // response) — server challenges with 402 again, but we must not pay twice.
    fetchMock.mockResolvedValueOnce(make402Response(requirements));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

    const signer = new StubSigner();
    const spendTracker = new InMemorySpendTracker();
    const client = createX402Client({ fetch: fetchMock, signer, spendTracker });

    const idempotencyKey = "assessment-123";
    const first = await client.request(
      "https://api.ledgero.xyz/v1/underwriting/assess",
      {},
      { idempotencyKey }
    );
    const second = await client.request(
      "https://api.ledgero.xyz/v1/underwriting/assess",
      {},
      { idempotencyKey }
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.x402?.reused).toBe(false);
    expect(second.x402?.reused).toBe(true);
    expect(signer.calls).toHaveLength(1); // the payment was only ever signed once

    const totalSpend = await spendTracker.getTotalSpend({ resource: requirements.resource });
    expect(totalSpend).toBe("10000"); // recorded only once — not double-paid
  });

  it("signs and pays independently for different idempotency keys", async () => {
    const requirements = makeRequirements();
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(make402Response(requirements));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    fetchMock.mockResolvedValueOnce(make402Response(requirements));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

    const signer = new StubSigner();
    const spendTracker = new InMemorySpendTracker();
    const client = createX402Client({ fetch: fetchMock, signer, spendTracker });

    await client.request("https://api.ledgero.xyz/v1/underwriting/assess", {}, { idempotencyKey: "assessment-1" });
    await client.request("https://api.ledgero.xyz/v1/underwriting/assess", {}, { idempotencyKey: "assessment-2" });

    expect(signer.calls).toHaveLength(2);
    expect(await spendTracker.getTotalSpend({ resource: requirements.resource })).toBe("20000");
  });

  it("throws PaymentFailedError when the server rejects the payment payload", async () => {
    const requirements = makeRequirements();
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(make402Response(requirements));
    fetchMock.mockResolvedValueOnce(make402Response(requirements));

    const signer = new StubSigner();
    const client = createX402Client({ fetch: fetchMock, signer });

    await expect(client.request("https://api.ledgero.xyz/v1/underwriting/assess")).rejects.toThrow(
      /rejected the payment payload/
    );
  });

  it("refuses to pay when the call would exceed the configured budget", async () => {
    const requirements = makeRequirements({ maxAmountRequired: "1000000" });
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(make402Response(requirements));

    const signer = new StubSigner();
    const spendTracker = new InMemorySpendTracker();
    const client = createX402Client({
      fetch: fetchMock,
      signer,
      spendTracker,
      budget: { maxAmount: "500000", scope: "resource" },
    });

    await expect(client.request("https://api.ledgero.xyz/v1/underwriting/assess")).rejects.toThrow(
      BudgetExceededError
    );
    expect(signer.calls).toHaveLength(0); // never even asked the signer to sign
    expect(fetchMock).toHaveBeenCalledTimes(1); // no payment retry attempted
    expect(await spendTracker.getTotalSpend()).toBe("0");
  });

  it("allows spend that stays within budget across multiple calls, then refuses the one that would tip it over", async () => {
    const requirements = makeRequirements({ maxAmountRequired: "4000" });
    const fetchMock = vi.fn<typeof fetch>();
    // Two successful paid calls (4000 + 4000 = 8000), then a third that would push to 12000 > cap 10000.
    fetchMock.mockResolvedValueOnce(make402Response(requirements));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    fetchMock.mockResolvedValueOnce(make402Response(requirements));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    fetchMock.mockResolvedValueOnce(make402Response(requirements));

    const signer = new StubSigner();
    const spendTracker = new InMemorySpendTracker();
    const client = createX402Client({
      fetch: fetchMock,
      signer,
      spendTracker,
      budget: { maxAmount: "10000", scope: "resource" },
    });

    await client.request("https://api.ledgero.xyz/v1/underwriting/assess");
    await client.request("https://api.ledgero.xyz/v1/underwriting/assess");

    await expect(client.request("https://api.ledgero.xyz/v1/underwriting/assess")).rejects.toThrow(
      BudgetExceededError
    );

    expect(signer.calls).toHaveLength(2);
    expect(await spendTracker.getTotalSpend({ resource: requirements.resource })).toBe("8000");
  });
});
