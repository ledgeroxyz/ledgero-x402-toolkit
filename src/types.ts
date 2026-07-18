import type { RateLimiterProvider } from "./rate-limit.js";
import type { RetryOptions } from "./retry.js";
import type { X402EventListener } from "./telemetry.js";

/**
 * x402 protocol version this toolkit targets. Sent/echoed on payment payloads
 * so a resource server can reason about which wire format it is parsing.
 */
export const X402_VERSION = 1;

/**
 * Describes what a resource server wants in exchange for the resource it
 * guarded with an HTTP 402. Parsed out of the `accepts` array of a 402
 * response body.
 *
 * This mirrors the general shape of the x402 protocol's payment requirements
 * object. See the README for the spec-conformance caveat.
 */
export interface PaymentRequirements {
  /** Payment scheme, e.g. "exact" (pay an exact amount once). */
  scheme: string;
  /** Chain/network identifier, e.g. "base-sepolia", "base", "polygon". */
  network: string;
  /** Maximum amount required, as a decimal integer string in atomic units of `asset`. */
  maxAmountRequired: string;
  /** Canonical identifier/URL of the protected resource being paid for. */
  resource: string;
  /** Human-readable description of what is being purchased. */
  description?: string;
  /** MIME type of the resource, if applicable. */
  mimeType?: string;
  /** Address (or account identifier) payment must be sent to. */
  payTo: string;
  /** Asset identifier required for payment, e.g. a token contract address. */
  asset: string;
  /** How long the payer has to complete payment before the requirements expire. */
  maxTimeoutSeconds?: number;
  /** Scheme/network-specific extra data (e.g. EIP-712 domain info). */
  extra?: Record<string, unknown>;
}

/**
 * Body of an HTTP 402 response: a list of acceptable ways to pay for the
 * resource, one of which the caller must satisfy.
 */
export interface PaymentRequirementsResponse {
  x402Version: number;
  /** Optional human-readable reason the server returned 402. */
  error?: string;
  accepts: PaymentRequirements[];
}

/**
 * A signed/authorized payment, ready to be sent back to the resource server
 * (typically base64-encoded into an `X-PAYMENT` header) as proof of payment.
 *
 * `payload` is intentionally opaque here — its shape is scheme-specific
 * (e.g. an EIP-3009 `transferWithAuthorization` signature for an "exact"
 * scheme on an EVM network). This package never inspects it; only the
 * `PaymentSigner` implementation and the resource server's facilitator need
 * to agree on its shape.
 */
export interface PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  payload: unknown;
}

/** Context handed to a `PaymentSigner` alongside the payment requirements. */
export interface SignContext {
  /** The URL of the request being paid for. */
  url: string;
  /** The `RequestInit` the caller originally passed to `X402Client#request`. */
  init: RequestInit;
  /** x402 protocol version echoed from the 402 response. */
  x402Version: number;
  /** Idempotency key for this logical call, if the caller supplied one. */
  idempotencyKey?: string;
}

/**
 * Pluggable signer that turns `PaymentRequirements` into a `PaymentPayload`.
 *
 * This package never holds private keys or talks to an RPC itself — callers
 * inject an implementation backed by whatever wallet/signing stack they use
 * (e.g. a viem `WalletClient`, a KMS-backed signer, a mocked test signer).
 */
export interface PaymentSigner {
  sign(requirements: PaymentRequirements, context: SignContext): Promise<PaymentPayload>;
}

/**
 * Pluggable store used to cache a payment payload per idempotency key, so
 * that retrying the SAME logical request (e.g. the same underwriting
 * assessment) reuses the payment that was already authorized instead of
 * signing and spending again.
 */
export interface IdempotencyStore {
  get(key: string): PaymentPayload | undefined | Promise<PaymentPayload | undefined>;
  set(key: string, payload: PaymentPayload): void | Promise<void>;
}

/** A single recorded payment, used for spend tracking and budget checks. */
export interface SpendRecord {
  /** Logical resource identifier the payment was made for (e.g. a URL or provider+endpoint label). */
  resource: string;
  /** Who was paid, if known (e.g. `payTo` from the payment requirements). */
  provider?: string;
  /** Amount paid, as a decimal integer string in atomic units of `asset`. */
  amount: string;
  asset: string;
  network: string;
  /** Unix epoch milliseconds when the spend was recorded. */
  timestamp: number;
}

/** Filter used to sum/list spend records. */
export interface SpendQuery {
  resource?: string;
  provider?: string;
  /** Only include records within this many milliseconds of `asOf` (default: now). */
  windowMs?: number;
  /** Reference point for `windowMs`; defaults to `Date.now()`. */
  asOf?: number;
}

/**
 * Pluggable ledger of what has been spent, so callers can back it with
 * whatever storage they want (in-memory for tests/single-process agents,
 * Redis/Postgres for multi-process deployments). `InMemorySpendTracker` is
 * the default implementation.
 */
export interface SpendTracker {
  recordSpend(record: SpendRecord): void | Promise<void>;
  getTotalSpend(query?: SpendQuery): string | Promise<string>;
  getRecords?(query?: SpendQuery): SpendRecord[] | Promise<SpendRecord[]>;
}

/**
 * A spending cap enforced before a payment is authorized. Ties conceptually
 * to LEDGERO paying for its own compute/data lookups per-assessment: a
 * budget can be scoped per resource (e.g. "never spend more than $2 total on
 * this one data provider per day") or applied globally.
 */
export interface BudgetPolicy {
  /** Maximum cumulative spend allowed, as a decimal integer string in atomic units. */
  maxAmount: string;
  /** Rolling time window in milliseconds the cap applies over. Omit for an all-time cumulative cap. */
  windowMs?: number;
  /** Whether the cap applies per-resource or across all resources. Defaults to "resource". */
  scope?: "resource" | "global";
}

/** Metadata about how (or whether) a request was paid for, attached to the returned `Response`. */
export interface X402PaymentInfo {
  paid: boolean;
  /** True if a previously-cached payment (by idempotency key) was reused instead of signing again. */
  reused?: boolean;
  requirements?: PaymentRequirements;
  payload?: PaymentPayload;
  /** Decoded `X-PAYMENT-RESPONSE` settlement info, if the server sent one. */
  settlement?: unknown;
}

/** The standard `Response` returned by `X402Client#request`, annotated with payment metadata. */
export type X402Response = Response & { x402?: X402PaymentInfo };

export interface X402ClientOptions {
  /** Underlying fetch implementation. Defaults to the global `fetch`; inject a mock for testing. */
  fetch?: typeof fetch;
  /** Produces payment payloads for 402 responses. Required — this package never signs on its own. */
  signer: PaymentSigner;
  /** Where spend is recorded. Defaults to a fresh `InMemorySpendTracker`. */
  spendTracker?: SpendTracker;
  /** Where signed payment payloads are cached per idempotency key. Defaults to a fresh in-memory store. */
  idempotencyStore?: IdempotencyStore;
  /** Default budget cap applied to every request, unless overridden per-call. */
  budget?: BudgetPolicy;
  /** Default retry/backoff behavior for transient network/5xx failures. */
  retry?: RetryOptions;
  /**
   * Optional rate limiter capping outbound request rate. Pass a single
   * `RateLimiter` to share one bucket across every request this client
   * makes, or a `(resourceKey: string) => RateLimiter` factory to cap each
   * resource/provider independently (one bucket per resource, created
   * lazily and cached). One token is consumed per logical `request()` call,
   * keyed by `options.resource` (falling back to the request URL).
   */
  rateLimiter?: RateLimiterProvider;
  /** Choose which of several acceptable payment options to use. Defaults to the first entry. */
  selectPaymentRequirements?: (accepts: PaymentRequirements[]) => PaymentRequirements;
  /** Called right before a payment is signed (after budget checks pass). */
  onPaymentAttempt?: (info: { requirements: PaymentRequirements; url: string }) => void;
  /** Called after a payment payload has been produced and recorded. */
  onPaymentSuccess?: (info: { requirements: PaymentRequirements; payload: PaymentPayload }) => void;
  /**
   * Optional structured event hook — fires `request_start`,
   * `payment_required`, `payment_signed`, `retry`, `budget_rejected`,
   * `response`, and `error` events over the lifetime of each `request()`
   * call. Use it to plug in your own logger/metrics without this package
   * taking a logging dependency. See `X402Event` for the event shapes.
   */
  onEvent?: X402EventListener;
}

export interface X402RequestOptions {
  /**
   * Identifies this logical call (e.g. "assess-doc-<id>"). When set, a
   * payment produced for a 402 on this call is cached and reused if the same
   * key is used again, instead of paying twice.
   */
  idempotencyKey?: string;
  /** Overrides the resource label used for spend tracking/budget checks (defaults to the 402's `resource` field). */
  resource?: string;
  /** Overrides the client-level budget for this call only. */
  budget?: BudgetPolicy;
  /** Overrides the client-level retry options for this call only. */
  retry?: RetryOptions;
}
