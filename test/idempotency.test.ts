import { describe, expect, it } from "vitest";
import { generateIdempotencyKey, InMemoryIdempotencyStore } from "../src/index.js";

describe("generateIdempotencyKey", () => {
  it("is deterministic for identical parts", async () => {
    const a = await generateIdempotencyKey(["assessment", "abc-123", "underwriting.assess"]);
    const b = await generateIdempotencyKey(["assessment", "abc-123", "underwriting.assess"]);
    expect(a).toBe(b);
  });

  it("differs when a part differs", async () => {
    const a = await generateIdempotencyKey(["assessment", "abc-123"]);
    const b = await generateIdempotencyKey(["assessment", "abc-124"]);
    expect(a).not.toBe(b);
  });

  it("does not collide across part boundaries", async () => {
    const a = await generateIdempotencyKey(["a b", "c"]);
    const b = await generateIdempotencyKey(["a", "b c"]);
    expect(a).not.toBe(b);
  });

  it("produces a hex-encoded SHA-256 digest", async () => {
    const key = await generateIdempotencyKey(["x"]);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("InMemoryIdempotencyStore", () => {
  it("round-trips a stored payment payload", () => {
    const store = new InMemoryIdempotencyStore();
    expect(store.get("k")).toBeUndefined();
    expect(store.has("k")).toBe(false);

    store.set("k", { x402Version: 1, scheme: "exact", network: "base", payload: { foo: "bar" } });

    expect(store.has("k")).toBe(true);
    expect(store.get("k")).toEqual({ x402Version: 1, scheme: "exact", network: "base", payload: { foo: "bar" } });
  });

  it("clear() removes all cached payloads", () => {
    const store = new InMemoryIdempotencyStore();
    store.set("k", { x402Version: 1, scheme: "exact", network: "base", payload: {} });
    store.clear();
    expect(store.get("k")).toBeUndefined();
  });
});
