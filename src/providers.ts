/**
 * Data-provider marketplace — the toolkit-side model of the LEDGERO dapp's
 * data-provider marketplace (whitepaper utility 5).
 *
 * In the dapp, external data sources (property registries, valuation feeds,
 * KYC/AML providers) register as providers that the underwriting agent queries
 * and pays **per lookup** in `$LDGR`. That "agent pays its own way per data
 * lookup" flow is exactly what the x402 payment layer in this package models,
 * so this module layers the same marketplace concept on top of `X402Client`:
 * providers are described the same way the dapp describes them, and each query
 * settles through the 402 → pay → retry flow (see `queryDataProvider` in
 * `./query.js`).
 *
 * The descriptor fields here mirror the dapp's `DataProvider`
 * (`app/lib/data-providers.server.ts`) and `PROVIDER_TYPES`
 * (`app/lib/economy-types.ts`) so the two model the same concept and the dapp
 * could adopt this payment layer directly.
 */

/**
 * Provider categories, matching the dapp's `PROVIDER_TYPES` exactly:
 * `registry` (property/asset registries), `valuation` (pricing/appraisal
 * feeds), `kyc_aml` (identity & compliance checks), and `other`.
 */
export const PROVIDER_TYPES = ["registry", "valuation", "kyc_aml", "other"] as const;

/** One of the marketplace provider categories. Matches the dapp's `ProviderType`. */
export type ProviderType = (typeof PROVIDER_TYPES)[number];

/**
 * Default per-query fee for a data provider.
 *
 * The LEDGERO dapp uses `5` `$LDGR` (its `DEFAULT_QUERY_FEE`). Amounts in this
 * toolkit are decimal integer strings in the paying asset's atomic units (see
 * `SpendRecord.amount`), so the default is expressed as the string `"5"`. The
 * value is only a default/advertised fee — it is configurable per provider,
 * and the amount actually charged for a lookup comes from the `402` response's
 * `maxAmountRequired`, which the resource server is authoritative over.
 */
export const DEFAULT_QUERY_FEE = "5";

/**
 * Descriptor for a data provider in the marketplace. Mirrors the dapp's
 * `DataProvider` shape (`id`, `name`, `providerType`, `queryFee`, ...) with
 * the addition of `resourceUrl` — the HTTP endpoint the x402 client actually
 * queries — since this toolkit settles a real per-lookup HTTP payment rather
 * than the dapp's in-ledger balance transfer.
 */
export interface DataProvider {
  /** Stable identifier, e.g. `prov_ab12...`. Used as the spend-tracking resource label. */
  id: string;
  /** Human-readable provider name. */
  name: string;
  /** Provider category. */
  providerType: ProviderType;
  /** HTTP endpoint the agent queries for a lookup (the resource guarded by a 402). */
  resourceUrl: string;
  /**
   * Advertised per-query fee, as a decimal integer string in the paying
   * asset's atomic units. Defaults to `DEFAULT_QUERY_FEE`. The amount actually
   * charged comes from the 402's `maxAmountRequired`.
   */
  queryFee: string;
  /** Optional human-readable description of what the provider returns. */
  description?: string;
}

/** Loose input accepted by `defineDataProvider`; unspecified fields are defaulted. */
export interface DataProviderInput {
  id?: string;
  name: string;
  providerType?: ProviderType;
  resourceUrl: string;
  /** Advertised per-query fee (atomic-unit string). Defaults to `DEFAULT_QUERY_FEE`. */
  queryFee?: string;
  description?: string;
}

/**
 * Per-provider aggregate query stats, the toolkit analog of the dapp's
 * `queryCount` / `totalEarned` columns. `totalSpent` is from the querying
 * agent's perspective (what the dapp counts as the provider's `totalEarned`),
 * as a decimal integer string in atomic units.
 */
export interface ProviderQueryStats {
  queryCount: number;
  totalSpent: string;
}

/**
 * Pluggable store of registered providers and their query stats. Consistent
 * with this package's other pluggable interfaces (`SpendTracker`,
 * `IdempotencyStore`): implement it against Redis/Postgres/etc. for a
 * multi-process deployment; `DataProviderRegistry` is the in-memory default.
 */
export interface DataProviderStore {
  /** Adds (or replaces, by `id`) a provider, initializing its stats if new. */
  register(provider: DataProvider): void | Promise<void>;
  /** Looks up a provider by id. */
  get(id: string): DataProvider | undefined | Promise<DataProvider | undefined>;
  /** Lists providers, optionally filtered to a single `providerType`. */
  list(providerType?: ProviderType): DataProvider[] | Promise<DataProvider[]>;
  /** Records a settled query against a provider: bumps `queryCount` and adds `amount` to `totalSpent`. */
  recordQuery(id: string, amount: string): void | Promise<void>;
  /** Returns aggregate stats for a provider (zeros if it has no recorded queries). */
  getStats(id: string): ProviderQueryStats | Promise<ProviderQueryStats>;
}

function randomId(prefix: string): string {
  const uuid =
    globalThis.crypto?.randomUUID?.() ??
    // Fallback for environments without Web Crypto's randomUUID.
    `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${uuid.replace(/-/g, "")}`;
}

/**
 * Normalizes loose provider input into a full `DataProvider`, filling
 * defaults: a generated `prov_` id, `providerType` of `"other"`, and a
 * `queryFee` of `DEFAULT_QUERY_FEE`. Mirrors how the dapp's `registerProvider`
 * fills defaults on insert.
 */
export function defineDataProvider(input: DataProviderInput): DataProvider {
  return {
    id: input.id ?? randomId("prov"),
    name: input.name,
    providerType: input.providerType ?? "other",
    resourceUrl: input.resourceUrl,
    queryFee: input.queryFee ?? DEFAULT_QUERY_FEE,
    description: input.description,
  };
}

/**
 * Default in-memory `DataProviderStore`. Registers providers, lists/filters
 * them by type, and tracks per-provider aggregate query stats — the toolkit
 * analog of the dapp's `data_provider` table. Fine for a single-process agent
 * or tests; back `DataProviderStore` with a real database for multi-process
 * deployments.
 */
export class DataProviderRegistry implements DataProviderStore {
  private readonly providers = new Map<string, DataProvider>();
  private readonly stats = new Map<string, ProviderQueryStats>();

  register(provider: DataProvider): void {
    this.providers.set(provider.id, provider);
    if (!this.stats.has(provider.id)) {
      this.stats.set(provider.id, { queryCount: 0, totalSpent: "0" });
    }
  }

  get(id: string): DataProvider | undefined {
    return this.providers.get(id);
  }

  list(providerType?: ProviderType): DataProvider[] {
    const all = Array.from(this.providers.values());
    return providerType ? all.filter((p) => p.providerType === providerType) : all;
  }

  recordQuery(id: string, amount: string): void {
    const current = this.stats.get(id) ?? { queryCount: 0, totalSpent: "0" };
    this.stats.set(id, {
      queryCount: current.queryCount + 1,
      totalSpent: (BigInt(current.totalSpent) + BigInt(amount)).toString(),
    });
  }

  getStats(id: string): ProviderQueryStats {
    return this.stats.get(id) ?? { queryCount: 0, totalSpent: "0" };
  }

  /** Removes all providers and stats. Mainly useful in tests. */
  clear(): void {
    this.providers.clear();
    this.stats.clear();
  }
}
