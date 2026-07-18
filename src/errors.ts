/** Base class for every error this package throws. */
export class X402ToolkitError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "X402ToolkitError";
  }
}

/** A 402 response was received but its `accepts` array had no usable entries. */
export class NoAcceptablePaymentRequirementsError extends X402ToolkitError {
  constructor(message = "No acceptable payment requirements were returned by the server.") {
    super(message);
    this.name = "NoAcceptablePaymentRequirementsError";
  }
}

/**
 * A payment could not be completed — either the signer failed to produce a
 * payment payload, or the server rejected the payment payload we sent it
 * (responded with 402 again after we paid).
 */
export class PaymentFailedError extends X402ToolkitError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PaymentFailedError";
  }
}

export interface BudgetExceededDetails {
  /** Spend already recorded within scope, before this call. */
  currentSpend: string;
  /** Amount this call would additionally spend. */
  additional: string;
  /** Configured cap. */
  cap: string;
  scope: "resource" | "global";
  resource: string;
}

/** A call was refused because it would push spend past a configured `BudgetPolicy` cap. */
export class BudgetExceededError extends X402ToolkitError {
  readonly details: BudgetExceededDetails;

  constructor(message: string, details: BudgetExceededDetails) {
    super(message);
    this.name = "BudgetExceededError";
    this.details = details;
  }
}

/** All retry attempts for a request were exhausted without success. */
export class MaxRetriesExceededError extends X402ToolkitError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MaxRetriesExceededError";
  }
}
