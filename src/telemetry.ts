import type { BudgetExceededDetails } from "./errors.js";
import type { PaymentRequirements } from "./types.js";

/** Discriminant for every telemetry event `X402Client` can emit via `onEvent`. */
export type X402EventType =
  | "request_start"
  | "payment_required"
  | "payment_signed"
  | "retry"
  | "budget_rejected"
  | "response"
  | "error";

interface X402EventBase<T extends X402EventType> {
  type: T;
  /** URL of the logical request this event belongs to. */
  url: string;
  /** Unix epoch milliseconds when the event was emitted. */
  timestamp: number;
}

/** A call to `X402Client#request` began, before any network activity. */
export interface RequestStartEvent extends X402EventBase<"request_start"> {
  idempotencyKey?: string;
}

/** The server responded 402 and its payment requirements were parsed. */
export interface PaymentRequiredEvent extends X402EventBase<"payment_required"> {
  /** Every entry in the 402 body's `accepts` array (may be empty). */
  requirements: PaymentRequirements[];
}

/**
 * A payment payload is ready to attach to the retry — either freshly
 * produced by the `PaymentSigner`, or reused from the idempotency cache.
 */
export interface PaymentSignedEvent extends X402EventBase<"payment_signed"> {
  requirements: PaymentRequirements;
  /** True if this payload came from the idempotency cache instead of a fresh `signer.sign()` call. */
  reused: boolean;
}

/** A transient failure (thrown error or 5xx response) triggered a backoff wait before the next attempt. */
export interface RetryEvent extends X402EventBase<"retry"> {
  /** 1-based attempt number that just failed. */
  attempt: number;
  /** Backoff delay, in milliseconds, before the next attempt. */
  delayMs: number;
  /** The error or `Response` that triggered this retry. */
  reason: unknown;
}

/** A payment was refused before signing because it would exceed a configured `BudgetPolicy`. */
export interface BudgetRejectedEvent extends X402EventBase<"budget_rejected"> {
  details: BudgetExceededDetails;
}

/** A request completed with a final response — either non-402, or the response to a paid retry. */
export interface ResponseEvent extends X402EventBase<"response"> {
  status: number;
  paid: boolean;
}

/**
 * A call failed for a reason other than a budget rejection — e.g. a network
 * error, a signer failure, the server rejecting a payment, or no acceptable
 * payment requirements in a 402 body.
 */
export interface ErrorEvent extends X402EventBase<"error"> {
  error: unknown;
}

/** Every event shape `X402Client#request` can emit through `onEvent`. */
export type X402Event =
  | RequestStartEvent
  | PaymentRequiredEvent
  | PaymentSignedEvent
  | RetryEvent
  | BudgetRejectedEvent
  | ResponseEvent
  | ErrorEvent;

/**
 * Optional hook for structured observability. Wire this up to your own
 * logger/metrics pipeline (e.g. pino, OpenTelemetry, a counter keyed by
 * `event.type`) without this package taking a logging dependency of its
 * own. Set via `X402ClientOptions#onEvent`.
 */
export type X402EventListener = (event: X402Event) => void;
