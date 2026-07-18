import { describe, expect, it } from "vitest";
import { BudgetExceededError, checkBudget, InMemorySpendTracker, type PaymentRequirements } from "../src/index.js";

const requirements: PaymentRequirements = {
  scheme: "exact",
  network: "base-sepolia",
  maxAmountRequired: "5000",
  resource: "https://api.ledgero.xyz/v1/underwriting/assess",
  payTo: "0xPayTo",
  asset: "0xUsdc",
};

describe("InMemorySpendTracker", () => {
  it("sums recorded spend and can scope by resource", async () => {
    const tracker = new InMemorySpendTracker();
    await tracker.recordSpend({ resource: "a", amount: "100", asset: "usdc", network: "base", timestamp: Date.now() });
    await tracker.recordSpend({ resource: "a", amount: "250", asset: "usdc", network: "base", timestamp: Date.now() });
    await tracker.recordSpend({ resource: "b", amount: "999", asset: "usdc", network: "base", timestamp: Date.now() });

    expect(await tracker.getTotalSpend({ resource: "a" })).toBe("350");
    expect(await tracker.getTotalSpend()).toBe("1349");
  });

  it("excludes spend outside the requested time window", async () => {
    const tracker = new InMemorySpendTracker();
    const now = Date.now();
    await tracker.recordSpend({ resource: "a", amount: "100", asset: "usdc", network: "base", timestamp: now - 100_000 });
    await tracker.recordSpend({ resource: "a", amount: "200", asset: "usdc", network: "base", timestamp: now - 1_000 });

    const total = await tracker.getTotalSpend({ resource: "a", windowMs: 5_000, asOf: now });
    expect(total).toBe("200");
  });

  it("clear() resets recorded spend", async () => {
    const tracker = new InMemorySpendTracker();
    await tracker.recordSpend({ resource: "a", amount: "100", asset: "usdc", network: "base", timestamp: Date.now() });
    tracker.clear();
    expect(await tracker.getTotalSpend()).toBe("0");
  });
});

describe("checkBudget", () => {
  it("allows a payment that stays within the cap", async () => {
    const tracker = new InMemorySpendTracker();
    await expect(
      checkBudget(tracker, { maxAmount: "10000" }, requirements, requirements.resource)
    ).resolves.toBeUndefined();
  });

  it("refuses a payment that would exceed the budget cap", async () => {
    const tracker = new InMemorySpendTracker();
    await tracker.recordSpend({
      resource: requirements.resource,
      amount: "8000",
      asset: requirements.asset,
      network: requirements.network,
      timestamp: Date.now(),
    });

    await expect(
      checkBudget(tracker, { maxAmount: "10000" }, requirements, requirements.resource)
    ).rejects.toThrow(BudgetExceededError);
  });

  it("allows a payment exactly at the cap boundary", async () => {
    const tracker = new InMemorySpendTracker();
    await tracker.recordSpend({
      resource: requirements.resource,
      amount: "5000",
      asset: requirements.asset,
      network: requirements.network,
      timestamp: Date.now(),
    });

    // current (5000) + this call (5000) === cap (10000) -> allowed, not "over" budget.
    await expect(
      checkBudget(tracker, { maxAmount: "10000" }, requirements, requirements.resource)
    ).resolves.toBeUndefined();
  });

  it("scopes the cap per-resource by default, ignoring spend on other resources", async () => {
    const tracker = new InMemorySpendTracker();
    await tracker.recordSpend({
      resource: "some-other-resource",
      amount: "9999999",
      asset: requirements.asset,
      network: requirements.network,
      timestamp: Date.now(),
    });

    await expect(
      checkBudget(tracker, { maxAmount: "10000", scope: "resource" }, requirements, requirements.resource)
    ).resolves.toBeUndefined();
  });

  it("enforces a global cap across all resources when scope is 'global'", async () => {
    const tracker = new InMemorySpendTracker();
    await tracker.recordSpend({
      resource: "some-other-resource",
      amount: "9000",
      asset: requirements.asset,
      network: requirements.network,
      timestamp: Date.now(),
    });

    await expect(
      checkBudget(tracker, { maxAmount: "10000", scope: "global" }, requirements, requirements.resource)
    ).rejects.toThrow(BudgetExceededError);
  });

  it("includes actionable details on the thrown error", async () => {
    const tracker = new InMemorySpendTracker();
    await tracker.recordSpend({
      resource: requirements.resource,
      amount: "8000",
      asset: requirements.asset,
      network: requirements.network,
      timestamp: Date.now(),
    });

    try {
      await checkBudget(tracker, { maxAmount: "10000" }, requirements, requirements.resource);
      expect.unreachable("expected checkBudget to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(BudgetExceededError);
      const budgetError = error as BudgetExceededError;
      expect(budgetError.details).toEqual({
        currentSpend: "8000",
        additional: "5000",
        cap: "10000",
        scope: "resource",
        resource: requirements.resource,
      });
    }
  });
});
