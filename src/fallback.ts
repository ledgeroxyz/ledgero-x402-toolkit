import type { X402Client } from "./client.js";
import { X402ToolkitError } from "./errors.js";
import type { X402RequestOptions, X402Response } from "./types.js";

/** One candidate provider to try, in order, for a `requestWithFallback` call. */
export interface FallbackProvider {
  /** Resource URL to try for this provider. */
  url: string | URL;
  /** Per-provider `RequestInit`. Each provider is a fully independent request — nothing is merged across providers. */
  init?: RequestInit;
  /** Per-provider request options (idempotency key, resource label, budget, retry). */
  options?: X402RequestOptions;
}

/** One provider's failure, recorded when `requestWithFallback` falls through to the next candidate. */
export interface ProviderFailure {
  provider: FallbackProvider;
  /** Index of this provider in the list passed to `requestWithFallback`. */
  index: number;
  error: unknown;
}

function urlOf(provider: FallbackProvider): string {
  return typeof provider.url === "string" ? provider.url : provider.url.toString();
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Thrown by `requestWithFallback` when every provider failed. Carries each
 * provider's individual failure reason (in `failures`) so callers can see
 * the whole picture instead of just the last error swallowing the rest.
 */
export class AllProvidersFailedError extends X402ToolkitError {
  readonly failures: ProviderFailure[];

  constructor(failures: ProviderFailure[]) {
    const summary = failures
      .map((failure) => `  [${failure.index}] ${urlOf(failure.provider)}: ${describeError(failure.error)}`)
      .join("\n");
    super(`All ${failures.length} provider(s) failed:\n${summary}`);
    this.name = "AllProvidersFailedError";
    this.failures = failures;
  }
}

/** Options for `requestWithFallback`. */
export interface FallbackRequestOptions {
  /** Called immediately after a provider fails, before moving on to the next one (or giving up). */
  onProviderFailure?: (failure: ProviderFailure) => void;
}

/**
 * Tries an ordered list of providers that serve logically the same resource
 * (e.g. several data providers that can each answer the same lookup), one at
 * a time, via `client.request`. Returns the first successful response.
 *
 * If a provider's request throws — a network error, `PaymentFailedError`,
 * `NoAcceptablePaymentRequirementsError`, `BudgetExceededError`, or anything
 * else `X402Client#request` can throw — it falls through to the next
 * provider instead of failing the whole call.
 *
 * If every provider fails, throws `AllProvidersFailedError` with each
 * provider's individual failure reason attached in `.failures`.
 *
 * This layers *across* distinct resources/providers; it is not a substitute
 * for the client's own `retry` option, which already retries transient
 * failures against a single provider before this function would see them.
 */
export async function requestWithFallback(
  client: X402Client,
  providers: ReadonlyArray<string | URL | FallbackProvider>,
  fallbackOptions: FallbackRequestOptions = {}
): Promise<X402Response> {
  if (providers.length === 0) {
    throw new X402ToolkitError("requestWithFallback requires at least one provider.");
  }

  const normalized: FallbackProvider[] = providers.map((provider) =>
    typeof provider === "string" || provider instanceof URL ? { url: provider } : provider
  );

  const failures: ProviderFailure[] = [];

  for (let index = 0; index < normalized.length; index++) {
    const provider = normalized[index];
    if (!provider) continue;

    try {
      return await client.request(provider.url, provider.init ?? {}, provider.options ?? {});
    } catch (error) {
      const failure: ProviderFailure = { provider, index, error };
      failures.push(failure);
      fallbackOptions.onProviderFailure?.(failure);
    }
  }

  throw new AllProvidersFailedError(failures);
}
