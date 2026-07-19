import { describe, expect, it, vi } from "vitest";
import {
  BudgetExceededError,
  createX402Client,
  DataProviderRegistry,
  defineDataProvider,
  InMemorySpendTracker,
  queryDataProvider,
  type PaymentPayload,
  type PaymentRequirements,
  type PaymentSigner,
  type SignContext,
} from "../src/index.js";

function make402Response(requirements: PaymentRequirements): Response {
  return new Response(JSON.stringify({ x402Version: 1, accepts: [requirements] }), {
    status: 402,
    headers: { "content-type": "application/json" },
  });
}

function makeRequirements(resource: string, amount: string): PaymentRequirements {
  return {
    scheme: "exact",
    network: "base-sepolia",
    maxAmountRequired: amount,
    resource,
    payTo: "0xProviderPayTo",
    asset: "0xUsdcAddress",
    description: "Per-lookup data query",
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
      payload: { signature: "0xsig" },
    };
  }
}

describe("queryDataProvider", () => {
  it("runs a 402 -> pay -> 200 lookup, records spend, and updates registry stats", async () => {
    const provider = defineDataProvider({
      id: "prov_registry",
      name: "County Registry",
      providerType: "registry",
      resourceUrl: "https://registry.example/v1/title-search",
      queryFee: "5",
    });

    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(make402Response(makeRequirements(provider.resourceUrl, "5")));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ owner: "ACME LLC" }), { status: 200 }));

    const signer = new StubSigner();
    const spendTracker = new InMemorySpendTracker();
    const registry = new DataProviderRegistry();
    registry.register(provider);

    const client = createX402Client({ fetch: fetchMock, signer, spendTracker });

    const result = await queryDataProvider(client, provider, { method: "POST" }, { registry });

    expect(result.paid).toBe(true);
    expect(result.reused).toBe(false);
    expect(result.recorded).toBe(true);
    expect(result.amountCharged).toBe("5");
    expect(result.response.status).toBe(200);
    await expect(result.response.json()).resolves.toEqual({ owner: "ACME LLC" });

    // The client hit the provider's resourceUrl.
    expect(fetchMock.mock.calls[0]?.[0]).toBe(provider.resourceUrl);

    // Spend is tracked against the provider id.
    expect(await spendTracker.getTotalSpend({ resource: provider.id })).toBe("5");

    // Registry stats mirror the dapp's queryCount / totalEarned.
    expect(registry.getStats(provider.id)).toEqual({ queryCount: 1, totalSpent: "5" });
  });

  it("accumulates registry stats across several distinct lookups", async () => {
    const provider = defineDataProvider({
      id: "prov_val",
      name: "Valuation Feed",
      providerType: "valuation",
      resourceUrl: "https://valuation.example/v1/appraise",
      queryFee: "5",
    });

    const fetchMock = vi.fn<typeof fetch>();
    // Two distinct lookups, each 402 then 200.
    fetchMock.mockResolvedValueOnce(make402Response(makeRequirements(provider.resourceUrl, "5")));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    fetchMock.mockResolvedValueOnce(make402Response(makeRequirements(provider.resourceUrl, "5")));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

    const signer = new StubSigner();
    const registry = new DataProviderRegistry();
    registry.register(provider);
    const client = createX402Client({ fetch: fetchMock, signer });

    await queryDataProvider(client, provider, {}, { registry, idempotencyKey: "lookup-1" });
    await queryDataProvider(client, provider, {}, { registry, idempotencyKey: "lookup-2" });

    expect(signer.calls).toHaveLength(2);
    expect(registry.getStats(provider.id)).toEqual({ queryCount: 2, totalSpent: "10" });
  });

  it("does not double-count a reused (idempotent) payment", async () => {
    const provider = defineDataProvider({
      id: "prov_kyc",
      name: "KYC Provider",
      providerType: "kyc_aml",
      resourceUrl: "https://kyc.example/v1/check",
      queryFee: "5",
    });

    const fetchMock = vi.fn<typeof fetch>();
    // First logical query: 402 -> 200. Retry of the SAME query: 402 -> 200 again.
    fetchMock.mockResolvedValueOnce(make402Response(makeRequirements(provider.resourceUrl, "5")));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    fetchMock.mockResolvedValueOnce(make402Response(makeRequirements(provider.resourceUrl, "5")));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

    const signer = new StubSigner();
    const spendTracker = new InMemorySpendTracker();
    const registry = new DataProviderRegistry();
    registry.register(provider);
    const client = createX402Client({ fetch: fetchMock, signer, spendTracker });

    const first = await queryDataProvider(client, provider, {}, { registry, idempotencyKey: "same-lookup" });
    const second = await queryDataProvider(client, provider, {}, { registry, idempotencyKey: "same-lookup" });

    expect(first.reused).toBe(false);
    expect(first.recorded).toBe(true);
    expect(second.reused).toBe(true);
    expect(second.recorded).toBe(false);

    expect(signer.calls).toHaveLength(1); // paid only once
    expect(await spendTracker.getTotalSpend({ resource: provider.id })).toBe("5");
    expect(registry.getStats(provider.id)).toEqual({ queryCount: 1, totalSpent: "5" }); // counted once
  });

  it("passes through a free (non-402) provider response without paying or recording", async () => {
    const provider = defineDataProvider({
      id: "prov_free",
      name: "Free Feed",
      resourceUrl: "https://free.example/v1/data",
    });

    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const signer = new StubSigner();
    const registry = new DataProviderRegistry();
    registry.register(provider);
    const client = createX402Client({ fetch: fetchMock, signer });

    const result = await queryDataProvider(client, provider, {}, { registry });

    expect(result.paid).toBe(false);
    expect(result.amountCharged).toBe("0");
    expect(result.recorded).toBe(false);
    expect(signer.calls).toHaveLength(0);
    expect(registry.getStats(provider.id)).toEqual({ queryCount: 0, totalSpent: "0" });
  });

  it("refuses (and does not record) a query that would exceed the budget cap", async () => {
    const provider = defineDataProvider({
      id: "prov_pricey",
      name: "Pricey Provider",
      providerType: "registry",
      resourceUrl: "https://pricey.example/v1/lookup",
      queryFee: "5",
    });

    const fetchMock = vi.fn<typeof fetch>();
    // Only the initial 402 is needed — payment is refused before any retry.
    fetchMock.mockResolvedValueOnce(make402Response(makeRequirements(provider.resourceUrl, "5")));

    const signer = new StubSigner();
    const spendTracker = new InMemorySpendTracker();
    const registry = new DataProviderRegistry();
    registry.register(provider);

    // Pre-existing spend of 8 against this provider; cap is 10, so a 5 lookup would tip to 13.
    await spendTracker.recordSpend({
      resource: provider.id,
      amount: "8",
      asset: "0xUsdcAddress",
      network: "base-sepolia",
      timestamp: Date.now(),
    });

    const client = createX402Client({ fetch: fetchMock, signer, spendTracker });

    await expect(
      queryDataProvider(client, provider, {}, { registry, budget: { maxAmount: "10", scope: "resource" } })
    ).rejects.toThrow(BudgetExceededError);

    expect(signer.calls).toHaveLength(0); // never signed
    expect(registry.getStats(provider.id)).toEqual({ queryCount: 0, totalSpent: "0" }); // not recorded
    expect(await spendTracker.getTotalSpend({ resource: provider.id })).toBe("8"); // unchanged
  });
});
