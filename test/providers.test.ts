import { describe, expect, it } from "vitest";
import {
  DataProviderRegistry,
  DEFAULT_QUERY_FEE,
  defineDataProvider,
  PROVIDER_TYPES,
  type DataProvider,
} from "../src/index.js";

describe("provider marketplace constants", () => {
  it("matches the dapp's provider types exactly", () => {
    expect(PROVIDER_TYPES).toEqual(["registry", "valuation", "kyc_aml", "other"]);
  });

  it("defaults the per-query fee to 5 (the dapp's DEFAULT_QUERY_FEE), as an atomic-unit string", () => {
    expect(DEFAULT_QUERY_FEE).toBe("5");
  });
});

describe("defineDataProvider", () => {
  it("fills defaults for id, providerType, and queryFee", () => {
    const provider = defineDataProvider({
      name: "County Registry",
      resourceUrl: "https://registry.example/v1/title-search",
    });

    expect(provider.id).toMatch(/^prov_/);
    expect(provider.providerType).toBe("other");
    expect(provider.queryFee).toBe(DEFAULT_QUERY_FEE);
    expect(provider.name).toBe("County Registry");
    expect(provider.resourceUrl).toBe("https://registry.example/v1/title-search");
  });

  it("respects explicitly provided fields", () => {
    const provider = defineDataProvider({
      id: "prov_fixed",
      name: "Appraisal Feed",
      providerType: "valuation",
      resourceUrl: "https://valuation.example/v1/appraise",
      queryFee: "12",
      description: "Automated valuation model",
    });

    expect(provider).toEqual<DataProvider>({
      id: "prov_fixed",
      name: "Appraisal Feed",
      providerType: "valuation",
      resourceUrl: "https://valuation.example/v1/appraise",
      queryFee: "12",
      description: "Automated valuation model",
    });
  });

  it("generates distinct ids across calls", () => {
    const a = defineDataProvider({ name: "A", resourceUrl: "https://a.example" });
    const b = defineDataProvider({ name: "B", resourceUrl: "https://b.example" });
    expect(a.id).not.toBe(b.id);
  });
});

describe("DataProviderRegistry", () => {
  function seed(): DataProviderRegistry {
    const registry = new DataProviderRegistry();
    registry.register(
      defineDataProvider({ id: "prov_reg", name: "Registry A", providerType: "registry", resourceUrl: "https://a.example" })
    );
    registry.register(
      defineDataProvider({ id: "prov_val", name: "Valuation B", providerType: "valuation", resourceUrl: "https://b.example" })
    );
    registry.register(
      defineDataProvider({ id: "prov_kyc", name: "KYC C", providerType: "kyc_aml", resourceUrl: "https://c.example" })
    );
    return registry;
  }

  it("registers and gets providers by id", () => {
    const registry = seed();
    expect(registry.get("prov_val")?.name).toBe("Valuation B");
    expect(registry.get("missing")).toBeUndefined();
  });

  it("lists all providers, and filters by type", () => {
    const registry = seed();
    expect(registry.list()).toHaveLength(3);
    expect(registry.list("registry").map((p) => p.id)).toEqual(["prov_reg"]);
    expect(registry.list("kyc_aml").map((p) => p.id)).toEqual(["prov_kyc"]);
    expect(registry.list("other")).toEqual([]);
  });

  it("re-registering by the same id replaces the descriptor but preserves stats", () => {
    const registry = seed();
    registry.recordQuery("prov_reg", "5");
    registry.register(
      defineDataProvider({ id: "prov_reg", name: "Registry A (renamed)", providerType: "registry", resourceUrl: "https://a2.example" })
    );

    expect(registry.get("prov_reg")?.name).toBe("Registry A (renamed)");
    expect(registry.getStats("prov_reg")).toEqual({ queryCount: 1, totalSpent: "5" });
  });

  it("starts every provider with zeroed stats", () => {
    const registry = seed();
    expect(registry.getStats("prov_reg")).toEqual({ queryCount: 0, totalSpent: "0" });
    expect(registry.getStats("unknown")).toEqual({ queryCount: 0, totalSpent: "0" });
  });

  it("accumulates queryCount and totalSpent across recorded queries", () => {
    const registry = seed();
    registry.recordQuery("prov_val", "5");
    registry.recordQuery("prov_val", "12");
    registry.recordQuery("prov_val", "3");

    expect(registry.getStats("prov_val")).toEqual({ queryCount: 3, totalSpent: "20" });
    // Other providers are untouched.
    expect(registry.getStats("prov_reg")).toEqual({ queryCount: 0, totalSpent: "0" });
  });

  it("clear() removes providers and stats", () => {
    const registry = seed();
    registry.recordQuery("prov_reg", "5");
    registry.clear();
    expect(registry.list()).toEqual([]);
    expect(registry.getStats("prov_reg")).toEqual({ queryCount: 0, totalSpent: "0" });
  });
});
