import { checkBudget } from "./budget.js";
import { BudgetExceededError, NoAcceptablePaymentRequirementsError, PaymentFailedError, X402ToolkitError } from "./errors.js";
import { InMemoryIdempotencyStore } from "./idempotency.js";
import { DEFAULT_RETRY_OPTIONS, withRetry, type RetryOptions } from "./retry.js";
import { InMemorySpendTracker } from "./spend-tracker.js";
import type { X402Event, X402EventListener } from "./telemetry.js";
import type {
  BudgetPolicy,
  IdempotencyStore,
  PaymentPayload,
  PaymentRequirements,
  PaymentRequirementsResponse,
  PaymentSigner,
  SignContext,
  SpendTracker,
  X402ClientOptions,
  X402RequestOptions,
  X402Response,
} from "./types.js";

const X_PAYMENT_HEADER = "X-PAYMENT";
const X_PAYMENT_RESPONSE_HEADER = "X-PAYMENT-RESPONSE";
const IDEMPOTENCY_HEADER = "Idempotency-Key";

function encodeBase64(value: string): string {
  if (typeof btoa === "function") return btoa(value);
  return Buffer.from(value, "utf-8").toString("base64");
}

function decodeBase64(value: string): string {
  if (typeof atob === "function") return atob(value);
  return Buffer.from(value, "base64").toString("utf-8");
}

function encodePaymentPayload(payload: PaymentPayload): string {
  return encodeBase64(JSON.stringify(payload));
}

function decodeSettlement(value: string): unknown {
  try {
    return JSON.parse(decodeBase64(value));
  } catch {
    // Settlement info is informational only — a malformed header shouldn't fail the call.
    return undefined;
  }
}

/**
 * HTTP client that transparently handles the x402 payment flow on top of
 * `fetch`: make a request, detect a 402, resolve payment requirements, get a
 * payment payload from an injected `PaymentSigner`, retry with proof of
 * payment attached, and return the final response.
 *
 * Also layers in idempotent retries (no double-pay for the same logical
 * call), budget enforcement, and retry/backoff for transient failures.
 * Construct via `createX402Client`.
 */
export class X402Client {
  private readonly fetchImpl: typeof fetch;
  private readonly signer: PaymentSigner;
  private readonly spendTracker: SpendTracker;
  private readonly idempotencyStore: IdempotencyStore;
  private readonly defaultBudget: BudgetPolicy | undefined;
  private readonly defaultRetry: RetryOptions;
  private readonly selectPaymentRequirements: (accepts: PaymentRequirements[]) => PaymentRequirements | undefined;
  private readonly onPaymentAttempt: X402ClientOptions["onPaymentAttempt"];
  private readonly onPaymentSuccess: X402ClientOptions["onPaymentSuccess"];
  private readonly onEvent: X402EventListener | undefined;

  constructor(options: X402ClientOptions) {
    if (!options.signer) {
      throw new X402ToolkitError("X402Client requires a `signer` implementing PaymentSigner.");
    }

    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.signer = options.signer;
    this.spendTracker = options.spendTracker ?? new InMemorySpendTracker();
    this.idempotencyStore = options.idempotencyStore ?? new InMemoryIdempotencyStore();
    this.defaultBudget = options.budget;
    this.defaultRetry = { ...DEFAULT_RETRY_OPTIONS, ...options.retry };
    this.selectPaymentRequirements = options.selectPaymentRequirements ?? ((accepts) => accepts[0]);
    this.onPaymentAttempt = options.onPaymentAttempt;
    this.onPaymentSuccess = options.onPaymentSuccess;
    this.onEvent = options.onEvent;
  }

  private emit(event: X402Event): void {
    this.onEvent?.(event);
  }

  /**
   * Performs a request, transparently paying for it if the server responds
   * with HTTP 402. Resolves to the final `Response` (200 or otherwise),
   * annotated with an `x402` field describing whether/how payment happened.
   *
   * Throws `BudgetExceededError` if payment would exceed a configured
   * budget, `PaymentFailedError` if the signer fails or the server rejects
   * the payment, or `NoAcceptablePaymentRequirementsError` if the 402 body
   * lists no usable payment option.
   */
  async request(input: string | URL, init: RequestInit = {}, options: X402RequestOptions = {}): Promise<X402Response> {
    const url = typeof input === "string" ? input : input.toString();
    this.emit({ type: "request_start", url, timestamp: Date.now(), idempotencyKey: options.idempotencyKey });

    try {
      return await this.performRequest(url, init, options);
    } catch (error) {
      // Budget rejections already emit their own, more specific `budget_rejected`
      // event below — avoid emitting a redundant generic `error` for them too.
      if (!(error instanceof BudgetExceededError)) {
        this.emit({ type: "error", url, timestamp: Date.now(), error });
      }
      throw error;
    }
  }

  private async performRequest(url: string, init: RequestInit, options: X402RequestOptions): Promise<X402Response> {
    const retryOptions: RetryOptions = {
      ...this.defaultRetry,
      ...options.retry,
      onRetry: (attempt, delayMs, reason) => {
        this.emit({ type: "retry", url, timestamp: Date.now(), attempt, delayMs, reason });
        (options.retry?.onRetry ?? this.defaultRetry.onRetry)?.(attempt, delayMs, reason);
      },
    };

    const initialHeaders = new Headers(init.headers);
    if (options.idempotencyKey) initialHeaders.set(IDEMPOTENCY_HEADER, options.idempotencyKey);

    const firstResponse = await withRetry(
      () => this.fetchImpl(url, { ...init, headers: initialHeaders }),
      retryOptions
    );

    if (firstResponse.status !== 402) {
      const response = firstResponse as X402Response;
      response.x402 = { paid: false };
      this.emit({ type: "response", url, timestamp: Date.now(), status: response.status, paid: false });
      return response;
    }

    const requirementsResponse = await this.parsePaymentRequirements(firstResponse);
    this.emit({
      type: "payment_required",
      url,
      timestamp: Date.now(),
      requirements: requirementsResponse.accepts,
    });

    const requirements = this.selectPaymentRequirements(requirementsResponse.accepts);
    if (!requirements) {
      throw new NoAcceptablePaymentRequirementsError();
    }

    const resourceLabel = options.resource ?? requirements.resource;
    const budget = options.budget ?? this.defaultBudget;

    const cached = options.idempotencyKey ? await this.idempotencyStore.get(options.idempotencyKey) : undefined;
    let paymentPayload = cached;
    const reused = Boolean(cached);

    if (!paymentPayload) {
      if (budget) {
        try {
          await checkBudget(this.spendTracker, budget, requirements, resourceLabel);
        } catch (error) {
          if (error instanceof BudgetExceededError) {
            this.emit({ type: "budget_rejected", url, timestamp: Date.now(), details: error.details });
          }
          throw error;
        }
      }

      this.onPaymentAttempt?.({ requirements, url });

      const signContext: SignContext = {
        url,
        init,
        x402Version: requirementsResponse.x402Version,
        idempotencyKey: options.idempotencyKey,
      };

      try {
        paymentPayload = await this.signer.sign(requirements, signContext);
      } catch (cause) {
        throw new PaymentFailedError("Payment signer failed to produce a payment payload.", { cause });
      }

      if (options.idempotencyKey) {
        await this.idempotencyStore.set(options.idempotencyKey, paymentPayload);
      }

      await this.spendTracker.recordSpend({
        resource: resourceLabel,
        provider: requirements.payTo,
        amount: requirements.maxAmountRequired,
        asset: requirements.asset,
        network: requirements.network,
        timestamp: Date.now(),
      });

      this.onPaymentSuccess?.({ requirements, payload: paymentPayload });
    }

    this.emit({ type: "payment_signed", url, timestamp: Date.now(), requirements, reused });

    const paidHeaders = new Headers(init.headers);
    if (options.idempotencyKey) paidHeaders.set(IDEMPOTENCY_HEADER, options.idempotencyKey);
    paidHeaders.set(X_PAYMENT_HEADER, encodePaymentPayload(paymentPayload));

    const secondResponse = await withRetry(
      () => this.fetchImpl(url, { ...init, headers: paidHeaders }),
      retryOptions
    );

    if (secondResponse.status === 402) {
      throw new PaymentFailedError(
        reused
          ? "Server rejected a reused (cached) payment payload after a 402 — the idempotency cache may be stale."
          : "Server rejected the payment payload after a 402; payment was not accepted."
      );
    }

    const response = secondResponse as X402Response;
    const settlementHeader = secondResponse.headers.get(X_PAYMENT_RESPONSE_HEADER);
    response.x402 = {
      paid: true,
      reused,
      requirements,
      payload: paymentPayload,
      settlement: settlementHeader ? decodeSettlement(settlementHeader) : undefined,
    };

    this.emit({ type: "response", url, timestamp: Date.now(), status: response.status, paid: true });

    return response;
  }

  private async parsePaymentRequirements(response: Response): Promise<PaymentRequirementsResponse> {
    let body: unknown;
    try {
      body = await response.clone().json();
    } catch (cause) {
      throw new X402ToolkitError("Failed to parse the 402 response body as JSON.", { cause });
    }

    const candidate = body as Partial<PaymentRequirementsResponse> | null;
    if (!candidate || !Array.isArray(candidate.accepts)) {
      throw new X402ToolkitError(
        'The 402 response body did not contain an `accepts` array of payment requirements.'
      );
    }

    return {
      x402Version: candidate.x402Version ?? 1,
      error: candidate.error,
      accepts: candidate.accepts,
    };
  }
}

/** Creates an `X402Client`. See `X402ClientOptions` for configuration. */
export function createX402Client(options: X402ClientOptions): X402Client {
  return new X402Client(options);
}
