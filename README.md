# @ledgeroxyz/x402-toolkit

A TypeScript toolkit for **x402** (HTTP `402 Payment Required`) machine-payment flows: make a request, get challenged with a 402 and a set of payment requirements, produce a payment proof, retry with proof attached, get your resource. Built for autonomous agents that pay per-request for their own compute and data — no human in the loop authorizing each call.

## Why this exists

[LEDGERO](https://ledgero.xyz) (`$LDGR`) is an AI underwriting agent for real-world-asset (RWA) tokenization. It runs continuously, and it pays for its own compute and third-party data lookups **per-assessment**, autonomously, via x402-style machine payments: the agent requests a resource, gets a `402` back with payment requirements, pays, retries with proof of payment, and gets the resource — all without a human clicking "approve" on each call. That's what makes the underwriting pipeline *autonomous* rather than merely automated.

This package is the general-purpose plumbing that pattern needs, extracted as a standalone, dependency-light library: 402 detection and payment-requirements parsing, a pluggable payment signer interface, idempotent retries so a flaky network doesn't cause a double-pay, budget enforcement so an agent can't blow past a spending cap, and retry/backoff for ordinary transient failures. It is pure client/utility logic — **no UI, no smart contract code**, and no hard dependency on any blockchain SDK or RPC provider. You inject a `PaymentSigner`; this package never touches a private key.

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

All types are exported from the single entry point, `@ledgeroxyz/x402-toolkit`.

### Errors

- `NoAcceptablePaymentRequirementsError` — a 402 body had an empty/missing `accepts` array.
- `PaymentFailedError` — the signer threw, or the server returned 402 again after payment.
- `BudgetExceededError` — the call was refused before paying because it would exceed a configured `BudgetPolicy`. Carries `.details` (`currentSpend`, `additional`, `cap`, `scope`, `resource`).
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
