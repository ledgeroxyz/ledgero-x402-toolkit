# @ledgeroxyz/x402-toolkit

A TypeScript toolkit for **x402** (HTTP `402 Payment Required`) machine-payment flows: make a request, get challenged with a 402 and a set of payment requirements, produce a payment proof, retry with proof attached, get your resource. Built for autonomous agents that pay per-request for their own compute and data — no human in the loop authorizing each call.

## Why this exists

[LEDGERO](https://ledgero.xyz) (`$LDGR`) is an AI underwriting agent for real-world-asset (RWA) tokenization. It runs continuously, and it pays for its own compute and third-party data lookups **per-assessment**, autonomously, via x402-style machine payments: the agent requests a resource, gets a `402` back with payment requirements, pays, retries with proof of payment, and gets the resource — all without a human clicking "approve" on each call. That's what makes the underwriting pipeline *autonomous* rather than merely automated.

This package is the general-purpose plumbing that pattern needs, extracted as a standalone, dependency-light library: 402 detection and payment-requirements parsing, a pluggable payment signer interface, idempotent retries so a flaky network doesn't cause a double-pay, budget enforcement so an agent can't blow past a spending cap, retry/backoff for ordinary transient failures, multi-provider fallback, rate limiting, structured telemetry hooks, and file-based persistent adapters for spend/idempotency state. It is pure client/utility logic — **no UI, no smart contract code**, and no hard dependency on any blockchain SDK or RPC provider. You inject a `PaymentSigner`; this package never touches a private key.

> **Spec-conformance note:** this package targets the *general shape* of x402, not a byte-for-byte-validated implementation of any specific facilitator. See [x402 spec-conformance note](#x402-spec-conformance-note) before integrating against a specific resource server.

## Install

```bash
pnpm add @ledgeroxyz/x402-toolkit
```

## Quickstart

### 1. Implement a `PaymentSigner`

The toolkit doesn't know or care which chain you're on — it hands you `PaymentRequirements` parsed from the 402 response and asks for a `PaymentPayload` back. Here's a sketch backed by a [viem](https://viem.sh) wallet client using EIP-3009 `transferWithAuthorization` (the "exact" scheme x402 commonly uses on EVM chains):

```ts
import type { PaymentSigner, PaymentRequirements, SignContext, PaymentPayload } from "@ledgeroxyz/x402-toolkit";
import type { WalletClient } from "viem";

function createViemPaymentSigner(walletClient: WalletClient): PaymentSigner {
  return {
    async sign(requirements: PaymentRequirements, context: SignContext): Promise<PaymentPayload> {
      // Build and sign a transferWithAuthorization (or your scheme of choice)
      // for `requirements.maxAmountRequired` of `requirements.asset`,
      // payable to `requirements.payTo` on `requirements.network`.
      const signature = await walletClient.signTypedData({
        /* ...EIP-712 domain/types/message derived from `requirements` and `requirements.extra` */
      });

      return {
        x402Version: context.x402Version,
        scheme: requirements.scheme,
        network: requirements.network,
        payload: {
          signature,
          authorization: {
            from: walletClient.account!.address,
            to: requirements.payTo,
            value: requirements.maxAmountRequired,
            // nonce, validAfter, validBefore, etc.
          },
        },
      };
    },
  };
}
```

### 2. Make a request

```ts
import { createX402Client } from "@ledgeroxyz/x402-toolkit";

const client = createX402Client({
  signer: createViemPaymentSigner(walletClient),
});

const response = await client.request("https://data-provider.example/v1/title-search", {
  method: "POST",
  body: JSON.stringify({ parcelId: "APN-123" }),
  headers: { "content-type": "application/json" },
});

const result = await response.json();
console.log(response.x402); // { paid: true, reused: false, requirements, payload, settlement }
```

Under the hood, if the first response is `402`, the client parses the `accepts` array from the response body, picks a payment option, asks your `signer` to produce a `PaymentPayload`, base64-encodes it into an `X-PAYMENT` header, and retries the exact same request. If that retry also comes back `402`, it throws `PaymentFailedError` rather than looping forever.

### 3. Avoid double-pay on retries with an idempotency key

If your process crashes or the network drops right after a payment settles but before you see the response, a naive retry would sign and spend again. Pass an `idempotencyKey` that identifies the *logical* call (e.g. one underwriting assessment), and the client will reuse the already-produced payment instead of paying twice:

```ts
const idempotencyKey = await generateIdempotencyKey(["assess", assessmentId, "title-search"]);
// or just use a business ID you already have: `assess-${assessmentId}-title-search`

await client.request(url, init, { idempotencyKey });
// ...later, retrying the same logical call...
await client.request(url, init, { idempotencyKey }); // signer is NOT called again
```

### 4. Enforce a spending budget

```ts
import { createX402Client, InMemorySpendTracker, BudgetExceededError } from "@ledgeroxyz/x402-toolkit";

const spendTracker = new InMemorySpendTracker();

const client = createX402Client({
  signer,
  spendTracker,
  budget: {
    maxAmount: "5000000", // 5 USDC, in 6-decimal atomic units
    windowMs: 24 * 60 * 60 * 1000, // rolling 24h
    scope: "resource", // cap applies per resource/provider, not globally
  },
});

try {
  await client.request(dataProviderUrl, init, { idempotencyKey });
} catch (error) {
  if (error instanceof BudgetExceededError) {
    // Refuse the lookup rather than blow the per-assessment budget.
    console.warn("Skipping data lookup — would exceed budget:", error.details);
  } else {
    throw error;
  }
}
```

Budgets can also be set (or overridden) per-call via the third argument's `budget` field, and `SpendTracker` is a plug-in interface — swap `InMemorySpendTracker` for a Redis/Postgres-backed implementation if you need spend tracked across processes.

### 5. Survive process restarts with file-based adapters

`InMemorySpendTracker` and `InMemoryIdempotencyStore` reset on every restart. For a single-process agent that needs its spend/idempotency state to survive a crash or redeploy without standing up Redis/Postgres, `FileSpendTracker` and `FileIdempotencyStore` persist to a JSON file on disk using only `node:fs/promises` — no new dependency:

```ts
import { createX402Client, FileSpendTracker, FileIdempotencyStore } from "@ledgeroxyz/x402-toolkit";

const client = createX402Client({
  signer,
  spendTracker: new FileSpendTracker("./data/spend.json"),
  idempotencyStore: new FileIdempotencyStore("./data/idempotency.json"),
});
```

Concurrent calls on the *same instance* are safely serialized (an internal mutex queues reads/writes, and each write goes through a temp-file-then-rename so a crash mid-write can't corrupt the file). This is **not** a multi-process-safe store — for spend/idempotency state shared across multiple processes, implement `SpendTracker`/`IdempotencyStore` against a real database instead.

### 6. Fall through to another provider on failure

If several providers can answer the same logical request (e.g. two data providers with equivalent title-search APIs), `requestWithFallback` tries them in order via your `X402Client`, moving to the next provider on any failure — network error, unresolvable payment requirements, a rejected payment, budget exceeded, whatever — instead of failing the whole call:

```ts
import { createX402Client, requestWithFallback, AllProvidersFailedError } from "@ledgeroxyz/x402-toolkit";

const client = createX402Client({ signer });

try {
  const response = await requestWithFallback(client, [
    "https://provider-a.example/v1/title-search",
    "https://provider-b.example/v1/title-search",
    { url: "https://provider-c.example/v1/title-search", init: { method: "POST" } },
  ]);
} catch (error) {
  if (error instanceof AllProvidersFailedError) {
    // error.failures: Array<{ provider, index, error }> — every provider's individual failure reason.
    console.error("All providers failed:", error.failures);
  } else {
    throw error;
  }
}
```

### 7. Plug in your own logger/metrics with telemetry hooks

`onEvent` fires structured events over the lifetime of each `request()` call — `request_start`, `payment_required`, `payment_signed`, `retry`, `budget_rejected`, `response`, and `error` — so you can log or emit metrics without this package taking a logging dependency:

```ts
import { createX402Client, type X402Event } from "@ledgeroxyz/x402-toolkit";

function logEvent(event: X402Event) {
  console.log(`[x402] ${event.type}`, event);
}

const client = createX402Client({ signer, onEvent: logEvent });
```

A typical 402 → pay → retry call fires `request_start` → `payment_required` → `payment_signed` → `response`, in order; a call refused by a budget cap fires `request_start` → `payment_required` → `budget_rejected` instead of paying.

### 8. Cap outbound request rate

`RateLimiter` is a dependency-free token-bucket limiter (configurable `ratePerSecond` + `burst`) that `X402Client` can optionally be configured with to cap how fast it makes outbound requests — useful for staying under a data provider's rate limit, or just pacing an agent's spend:

```ts
import { createX402Client, RateLimiter } from "@ledgeroxyz/x402-toolkit";

// A single shared bucket across every request this client makes:
const client = createX402Client({
  signer,
  rateLimiter: new RateLimiter({ ratePerSecond: 2, burst: 5, onLimitExceeded: "queue" }),
});

// Or a bucket PER resource/provider, created lazily:
const perResourceClient = createX402Client({
  signer,
  rateLimiter: (resourceKey) => new RateLimiter({ ratePerSecond: 1, burst: 3, onLimitExceeded: "reject" }),
});
```

`onLimitExceeded: "queue"` (the default) waits for a token before making the request; `"reject"` throws `RateLimitExceededError` immediately instead of waiting.

## API overview

| Export | What it is |
|---|---|
| `createX402Client(options)` | Builds an `X402Client`. |
| `X402Client#request(url, init?, options?)` | Fetch-alike that transparently handles the 402 → pay → retry flow. Returns a `Response` annotated with `.x402`. |
| `PaymentRequirements` | Parsed shape of one entry in a 402 body's `accepts` array (`scheme`, `network`, `maxAmountRequired`, `resource`, `payTo`, `asset`, `description`, ...). |
| `PaymentSigner` | Interface you implement: `sign(requirements, context) => Promise<PaymentPayload>`. Bring your own wallet/signing stack. |
| `PaymentPayload` | What your signer returns; base64-encoded into the `X-PAYMENT` header on retry. |
| `SpendTracker` / `InMemorySpendTracker` | Records what's been spent per resource/provider/time-window; pluggable storage. |
| `BudgetPolicy` / `checkBudget` / `BudgetExceededError` | Caller-supplied spending cap, enforced before a payment is authorized. |
| `IdempotencyStore` / `InMemoryIdempotencyStore` / `generateIdempotencyKey` | Cache a payment payload per logical call so retries don't double-pay. |
| `withRetry` / `RetryOptions` | Exponential backoff for transient network errors and 5xx responses — deliberately independent of 402 handling. |
| `X402ClientOptions` / `X402RequestOptions` | Client-level and per-call configuration. |
| `FileSpendTracker` / `FileIdempotencyStore` | JSON-file-backed `SpendTracker`/`IdempotencyStore`, so spend and idempotency state survive process restarts. `node:fs/promises` only, no new dependency. |
| `requestWithFallback` / `FallbackProvider` / `AllProvidersFailedError` | Tries an ordered list of providers for the same logical resource via `X402Client`, falling through to the next on any failure. |
| `RateLimiter` / `RateLimiterOptions` / `RateLimiterProvider` / `RateLimitExceededError` | Token-bucket rate limiter; wire into `X402ClientOptions#rateLimiter` to cap outbound request rate globally or per resource/provider. |
| `X402Event` / `X402EventListener` / `X402ClientOptions#onEvent` | Structured telemetry hook — `request_start`, `payment_required`, `payment_signed`, `retry`, `budget_rejected`, `response`, `error` — for plugging in your own logger/metrics. |

All types are exported from the single entry point, `@ledgeroxyz/x402-toolkit`.

### Errors

- `NoAcceptablePaymentRequirementsError` — a 402 body had an empty/missing `accepts` array.
- `PaymentFailedError` — the signer threw, or the server returned 402 again after payment.
- `BudgetExceededError` — the call was refused before paying because it would exceed a configured `BudgetPolicy`. Carries `.details` (`currentSpend`, `additional`, `cap`, `scope`, `resource`).
- `AllProvidersFailedError` — every provider passed to `requestWithFallback` failed. Carries `.failures` (`Array<{ provider, index, error }>`).
- `RateLimitExceededError` — a `RateLimiter` configured with `onLimitExceeded: "reject"` had no token available.
- `MaxRetriesExceededError` — exported for custom `shouldRetry`/retry-wrapper code that wants a dedicated exhausted-retries error type. `withRetry` itself currently rethrows the last underlying error rather than wrapping it in this.
- `X402ToolkitError` — base class for everything above.

## x402 spec-conformance note

This package targets the **general shape** of the x402 protocol as commonly described: an HTTP `402` response whose JSON body contains `x402Version` and an `accepts` array of payment-requirements objects (`scheme`, `network`, `maxAmountRequired`, `resource`, `payTo`, `asset`, `description`, `maxTimeoutSeconds`, `extra`), and a client that replies with a base64-encoded JSON payment payload in an `X-PAYMENT` header, optionally receiving settlement details back in an `X-PAYMENT-RESPONSE` header. It does **not** implement any specific payment scheme's cryptography (e.g. EIP-3009 signing) — that's intentionally left to your injected `PaymentSigner` — and it has not been byte-for-byte validated against a reference x402 facilitator. If you're integrating against a specific facilitator or resource server, verify field names and encoding against their docs and adjust as needed. Contributions tightening spec conformance are welcome.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## License

MIT © ledgeroxyz
