import { describe, expect, it, vi } from "vitest";
import {
  createX402Client,
  InMemorySpendTracker,
  type PaymentPayload,
  type PaymentRequirements,
  type PaymentSigner,
  type SignContext,
  type X402Event,
  type X402EventType,
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
    resource: "https://api.ledgero.xyz/v1/underwriting/assess",
    payTo: "0xPayTo",
    asset: "0xUsdc",
    ...overrides,
  };
}

class StubSigner implements PaymentSigner {
  async sign(requirements: PaymentRequirements, context: SignContext): Promise<PaymentPayload> {
    return {
      x402Version: context.x402Version,
      scheme: requirements.scheme,
      network: requirements.network,
      payload: { signature: "0xdeadbeef" },
    };
  }
}

function eventTypes(events: X402Event[]): X402EventType[] {
  return events.map((event) => event.type);
}

describe("X402Client telemetry (onEvent)", () => {
  it("fires request_start, payment_required, payment_signed, response for a 402 -> pay -> retry flow", async () => {
    const requirements = makeRequirements();
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(make402Response(requirements));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const events: X402Event[] = [];
    const client = createX402Client({
      fetch: fetchMock,
      signer: new StubSigner(),
      onEvent: (event) => events.push(event),
    });

    const response = await client.request("https://api.ledgero.xyz/v1/underwriting/assess", { method: "POST" });

    expect(response.status).toBe(200);
    expect(eventTypes(events)).toEqual(["request_start", "payment_required", "payment_signed", "response"]);

    const paymentRequired = events[1];
    if (paymentRequired?.type !== "payment_required") throw new Error("expected payment_required event");
    expect(paymentRequired.requirements).toEqual([requirements]);

    const paymentSigned = events[2];
    if (paymentSigned?.type !== "payment_signed") throw new Error("expected payment_signed event");
    expect(paymentSigned.reused).toBe(false);
    expect(paymentSigned.requirements).toEqual(requirements);

    const responseEvent = events[3];
    if (responseEvent?.type !== "response") throw new Error("expected response event");
    expect(responseEvent.status).toBe(200);
    expect(responseEvent.paid).toBe(true);
  });

  it("fires payment_signed with reused: true when an idempotency-cached payload is reused", async () => {
    const requirements = makeRequirements();
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(make402Response(requirements));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    fetchMock.mockResolvedValueOnce(make402Response(requirements));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

    const events: X402Event[] = [];
    const client = createX402Client({
      fetch: fetchMock,
      signer: new StubSigner(),
      onEvent: (event) => events.push(event),
    });

    const idempotencyKey = "assessment-123";
    await client.request("https://api.ledgero.xyz/v1/underwriting/assess", {}, { idempotencyKey });
    events.length = 0; // only care about the second, reused call
    await client.request("https://api.ledgero.xyz/v1/underwriting/assess", {}, { idempotencyKey });

    expect(eventTypes(events)).toEqual(["request_start", "payment_required", "payment_signed", "response"]);
    const paymentSigned = events[2];
    if (paymentSigned?.type !== "payment_signed") throw new Error("expected payment_signed event");
    expect(paymentSigned.reused).toBe(true);
  });

  it("fires request_start, payment_required, budget_rejected (no generic error) for a budget rejection", async () => {
    const requirements = makeRequirements({ maxAmountRequired: "1000000" });
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(make402Response(requirements));

    const events: X402Event[] = [];
    const client = createX402Client({
      fetch: fetchMock,
      signer: new StubSigner(),
      spendTracker: new InMemorySpendTracker(),
      budget: { maxAmount: "500000", scope: "resource" },
      onEvent: (event) => events.push(event),
    });

    await expect(client.request("https://api.ledgero.xyz/v1/underwriting/assess")).rejects.toThrow();

    expect(eventTypes(events)).toEqual(["request_start", "payment_required", "budget_rejected"]);
    const budgetRejected = events[2];
    if (budgetRejected?.type !== "budget_rejected") throw new Error("expected budget_rejected event");
    expect(budgetRejected.details).toMatchObject({ cap: "500000", additional: "1000000" });
  });

  it("fires an error event when the server rejects the payment payload after a 402", async () => {
    const requirements = makeRequirements();
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(make402Response(requirements));
    fetchMock.mockResolvedValueOnce(make402Response(requirements));

    const events: X402Event[] = [];
    const client = createX402Client({
      fetch: fetchMock,
      signer: new StubSigner(),
      onEvent: (event) => events.push(event),
    });

    await expect(client.request("https://api.ledgero.xyz/v1/underwriting/assess")).rejects.toThrow(
      /rejected the payment payload/
    );

    expect(eventTypes(events)).toEqual(["request_start", "payment_required", "payment_signed", "error"]);
  });

  it("fires request_start and response (paid: false) for a non-402 response, with no payment events", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const events: X402Event[] = [];
    const client = createX402Client({
      fetch: fetchMock,
      signer: new StubSigner(),
      onEvent: (event) => events.push(event),
    });

    await client.request("https://api.ledgero.xyz/v1/underwriting/assess");

    expect(eventTypes(events)).toEqual(["request_start", "response"]);
    const responseEvent = events[1];
    if (responseEvent?.type !== "response") throw new Error("expected response event");
    expect(responseEvent.paid).toBe(false);
  });

  it("fires retry events with attempt/delayMs during backoff on transient 5xx failures", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const events: X402Event[] = [];
    const client = createX402Client({
      fetch: fetchMock,
      signer: new StubSigner(),
      onEvent: (event) => events.push(event),
      retry: { maxAttempts: 3, baseDelayMs: 5, jitter: false, sleep: async () => {} },
    });

    await client.request("https://api.ledgero.xyz/v1/underwriting/assess");

    expect(eventTypes(events)).toEqual(["request_start", "retry", "response"]);
    const retryEvent = events[1];
    if (retryEvent?.type !== "retry") throw new Error("expected retry event");
    expect(retryEvent.attempt).toBe(1);
    expect(retryEvent.delayMs).toBe(5);
  });
});
