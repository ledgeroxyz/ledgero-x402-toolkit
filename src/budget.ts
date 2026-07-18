import { BudgetExceededError } from "./errors.js";
import type { BudgetPolicy, PaymentRequirements, SpendTracker } from "./types.js";

/**
 * Throws `BudgetExceededError` if authorizing `requirements.maxAmountRequired`
 * would push spend (within `policy`'s scope/window) past `policy.maxAmount`.
 * Amounts are compared as `BigInt`, so they must be decimal integer strings
 * in the asset's atomic units (e.g. USDC's 6-decimal base units).
 */
export async function checkBudget(
  spendTracker: SpendTracker,
  policy: BudgetPolicy,
  requirements: PaymentRequirements,
  resourceLabel: string
): Promise<void> {
  const scope = policy.scope ?? "resource";

  const currentSpend = BigInt(
    await spendTracker.getTotalSpend({
      resource: scope === "resource" ? resourceLabel : undefined,
      windowMs: policy.windowMs,
    })
  );
  const additional = BigInt(requirements.maxAmountRequired);
  const cap = BigInt(policy.maxAmount);
  const projected = currentSpend + additional;

  if (projected > cap) {
    throw new BudgetExceededError(
      `Budget exceeded for ${scope === "resource" ? `resource "${resourceLabel}"` : "global scope"}: ` +
        `current spend ${currentSpend} + this call's ${additional} = ${projected} > cap ${cap}`,
      {
        currentSpend: currentSpend.toString(),
        additional: additional.toString(),
        cap: cap.toString(),
        scope,
        resource: resourceLabel,
      }
    );
  }
}
