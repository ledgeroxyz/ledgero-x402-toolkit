import { describe, expect, it, vi } from "vitest";
import {
  AllProvidersFailedError,
  createX402Client,
  requestWithFallback,
  type PaymentPayload,
  type PaymentRequirements,
  type PaymentSigner,
  type SignContext,
} from "../src/index.js";

function make402Response(requirements: PaymentRequirements): Response {
  const body = { x402Version: 1, accepts: [requirements] };
  return new Response(JSON.stringify(body), { status: 402, headers: { "content-type": "application/json" } });
}

function makeRequirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: "base-sepolia",
    maxAmountRequired: "10000",
    resource: "https://provider.example/v1/title-search",
    payTo: "0xPayTo",
    asset: "0xUsdc",
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
      payload: { signature: "0xdeadbeef" },
    };
  }
}

describe("requestWithFallback", () => {
  it("falls through to the next provider on a network error and returns the first success", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    // Provider 0: network error.
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED provider-a.example"));
    // Provider 1: succeeds directly (no 402).
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const signer = new StubSigner();
    const client = createX402Client({ fetch: fetchMock, signer, retry: { maxAttempts: 1 } });

    const onProviderFailure = vi.fn();
    const response = await requestWithFallback(
      client,
      ["https://provider-a.example/v1/title-search", "https://provider-b.example/v1/title-search"],
      { onProviderFailure }
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onProviderFailure).toHaveBeenCalledTimes(1);
    expect(onProviderFailure.mock.calls[0]?.[0]).toMatchObject({ index: 0 });
  });

  it("falls through past a provider whose 402 has no acceptable payment requirements", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    // Provider 0: 402 with an empty `accepts` array — unresolvable payment requirements.
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ x402Version: 1, accepts: [] }), {
        status: 402,
        headers: { "content-type": "application/json" },
      })
    );
    // Provider 1: 402 then pays successfully.
    const requirements = makeRequirements({ resource: "https://provider-b.example/v1/title-search" });
    fetchMock.mockResolvedValueOnce(make402Response(requirements));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const signer = new StubSigner();
    const client = createX402Client({ fetch: fetchMock, signer });

    const response = await requestWithFallback(client, [
      "https://provider-a.example/v1/title-search",
      "https://provider-b.example/v1/title-search",
    ]);

    expect(response.status).toBe(200);
    expect(response.x402?.paid).toBe(true);
    expect(signer.calls).toHaveLength(1);
  });

  it("throws AllProvidersFailedError with every provider's failure reason when all providers fail", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockRejectedValueOnce(new Error("timeout on a"));
    fetchMock.mockRejectedValueOnce(new Error("timeout on b"));

    const signer = new StubSigner();
    const client = createX402Client({ fetch: fetchMock, signer, retry: { maxAttempts: 1 } });

    try {
      await requestWithFallback(client, ["https://provider-a.example", "https://provider-b.example"]);
      expect.unreachable("expected requestWithFallback to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AllProvidersFailedError);
      const fallbackError = error as AllProvidersFailedError;
      expect(fallbackError.failures).toHaveLength(2);
      expect(fallbackError.failures[0]?.index).toBe(0);
      expect(fallbackError.failures[1]?.index).toBe(1);
      expect(String((fallbackError.failures[0]?.error as Error).message)).toContain("timeout on a");
      expect(fallbackError.message).toContain("provider-a.example");
      expect(fallbackError.message).toContain("provider-b.example");
    }
  });

  it("supports FallbackProvider objects with per-provider init/options", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const signer = new StubSigner();
    const client = createX402Client({ fetch: fetchMock, signer });

    const response = await requestWithFallback(client, [
      { url: "https://provider-a.example", init: { method: "POST" }, options: { resource: "custom-resource" } },
    ]);

    expect(response.status).toBe(200);
    const callInit = fetchMock.mock.calls[0]?.[1];
    expect(callInit?.method).toBe("POST");
  });

  it("rejects an empty provider list", async () => {
    const signer = new StubSigner();
    const client = createX402Client({ fetch: vi.fn<typeof fetch>(), signer });

    await expect(requestWithFallback(client, [])).rejects.toThrow(/at least one provider/);
  });
});
