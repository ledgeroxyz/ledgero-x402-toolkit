import type { IdempotencyStore, PaymentPayload } from "./types.js";

/**
 * Default `IdempotencyStore`: caches signed payment payloads in a `Map`.
 * This is what makes retrying the SAME logical call (e.g. the same
 * underwriting assessment) reuse the payment already authorized instead of
 * signing — and spending — again. Scoped to the process; for multi-process
 * agents, back `IdempotencyStore` with Redis or similar instead.
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly store = new Map<string, PaymentPayload>();

  get(key: string): PaymentPayload | undefined {
    return this.store.get(key);
  }

  set(key: string, payload: PaymentPayload): void {
    this.store.set(key, payload);
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  /** Removes all cached payment payloads. Mainly useful in tests. */
  clear(): void {
    this.store.clear();
  }
}

/**
 * Deterministically derives an idempotency key from one or more parts of a
 * logical request (e.g. `["assess", assessmentId, providerId]`). Hashed with
 * SHA-256 via the Web Crypto API, which is available globally in Node 18+
 * and in browsers, so this package never needs a hashing dependency.
 *
 * If you already have a stable business identifier for the logical call
 * (e.g. an assessment ID), prefer passing it directly as the idempotency key
 * — this helper exists for composing several values into one deterministic
 * key when you don't have a single natural one.
 */
export async function generateIdempotencyKey(parts: ReadonlyArray<string | number | boolean>): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      "generateIdempotencyKey() requires the Web Crypto API (globalThis.crypto.subtle), which is not " +
        "available in this environment. Pass a pre-computed idempotency key to `request()` instead."
    );
  }

  // JSON-encode each part so values containing delimiters cannot
  // collide across part boundaries (e.g. ["a b", "c"] vs ["a", "b c"]).
  const input = parts.map((part) => JSON.stringify(part)).join(",");
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(input));

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
