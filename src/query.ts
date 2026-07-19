import type { X402Client } from "./client.js";
import type { DataProvider, DataProviderStore } from "./providers.js";
import type { BudgetPolicy, X402Response } from "./types.js";

/** Options for `queryDataProvider`. */
export interface QueryDataProviderOptions {
  /**
   * Registry to record the settled query against. When supplied, a freshly
   * paid query bumps the provider's `queryCount` and adds the charged amount
   * to its `totalSpent` (the toolkit analog of the dapp's `queryProvider`
   * updating `queryCount`/`totalEarned`). A query that reused a cached payment
   * — see `idempotencyKey` — is not re-counted, keeping registry stats
   * consistent with the underlying `SpendTracker`, which also records each
   * payment only once.
   */
  registry?: DataProviderStore;
  /**
   * Identifies this logical lookup so a retry of the SAME query reuses the
   * already-authorized payment instead of paying twice. Forwarded to
   * `X402Client#request`. Defaults to the provider id if omitted.
   */
  idempotencyKey?: string;
  /**
   * Budget cap for this lookup, forwarded to `X402Client#request`. If neither
   * this nor the client's default budget is set, no per-query cap is enforced.
   * When the query would exceed the cap, the client throws `BudgetExceededError`
   * before signing — the query is refused, nothing is spent or counted.
   */
  budget?: BudgetPolicy;
}

/** Result of a data-provider query. */
export interface QueryDataProviderResult {
  /** The final HTTP response, annotated with `.x402` payment metadata. */
  response: X402Response;
  /** True if the lookup required (and made) a payment. */
  paid: boolean;
  /** True if a previously-cached payment was reused instead of paying again. */
  reused: boolean;
  /**
   * Amount charged for this lookup, as a decimal integer string in atomic
   * units — the 402's `maxAmountRequired` when paid, `"0"` when the resource
   * was free (non-402). The resource server, not the provider's advertised
   * `queryFee`, is authoritative over the amount.
   */
  amountCharged: string;
  /** True if this query was recorded against the registry's stats (paid and not reused). */
  recorded: boolean;
}

/**
 * Runs a data-provider lookup through the x402 payment layer.
 *
 * This is the toolkit analog of the dapp's `queryProvider`: it queries the
 * provider's `resourceUrl` via the given `X402Client`, so the full
 * 402 → pay → retry flow, idempotency, retry/backoff, rate limiting, and
 * budget enforcement all apply. Spend is recorded by the client against the
 * provider (the spend-tracking resource label is the provider `id`), and — if
 * an `options.registry` is supplied — the provider's aggregate
 * `queryCount`/`totalSpent` stats are bumped, mirroring how the dapp's
 * `queryProvider` increments `queryCount`/`totalEarned`.
 *
 * Budget enforcement is delegated to the client: if a budget cap (client-level
 * or `options.budget`) would be exceeded, the client throws
 * `BudgetExceededError` before signing, and this function refuses the query —
 * nothing is spent, and the registry is not touched.
 */
export async function queryDataProvider(
  client: X402Client,
  provider: DataProvider,
  requestInit: RequestInit = {},
  options: QueryDataProviderOptions = {}
): Promise<QueryDataProviderResult> {
  const response = await client.request(provider.resourceUrl, requestInit, {
    // Tie spend tracking + per-resource budget to the provider itself.
    resource: provider.id,
    idempotencyKey: options.idempotencyKey ?? provider.id,
    budget: options.budget,
  });

  const paid = response.x402?.paid ?? false;
  const reused = response.x402?.reused ?? false;
  const amountCharged = paid ? response.x402?.requirements?.maxAmountRequired ?? "0" : "0";

  // Record against the registry only when the client actually settled a fresh
  // payment — a reused (idempotent) payment was already counted, and the
  // SpendTracker likewise records each payment only once.
  const recorded = Boolean(options.registry) && paid && !reused;
  if (recorded) {
    await options.registry!.recordQuery(provider.id, amountCharged);
  }

  return { response, paid, reused, amountCharged, recorded };
}
