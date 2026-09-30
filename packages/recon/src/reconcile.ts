import { compare, isZero, type Money, subtract } from "@corridoros/core";
import type { Invoice, ReconBreak, ReconResult } from "@corridoros/domain";

export interface ReconInputs {
  invoice: Invoice;
  expected: Money;
  /** The actual INR credit received; undefined/zero models a missing credit. */
  actual: Money;
  /** Hop id responsible for a short payment, when the route reported one. */
  deductingHopId?: string;
  landedAt: string;
  /** Reference on the incoming credit; undefined/mismatched models a wrong-reference break. */
  reference?: string | null;
  invoiceReference?: string;
}

/**
 * Match one incoming INR credit to its invoice (CLAUDE.md §10.1). This demo matches by
 * reference first (when both are present and match), falling back to amount comparison.
 * Scope: short payment, overpayment and missing credit are fully modeled; multi-invoice
 * batching and duplicate-credit detection are represented in ReconBreakType but not exercised
 * by the bundled scenarios — see README for the honest scope note.
 */
export function reconcile(inputs: ReconInputs): ReconResult {
  const breaks: ReconBreak[] = [];
  const referenceKnown = inputs.reference !== undefined && inputs.reference !== null;
  const referenceMatches = referenceKnown && inputs.invoiceReference !== undefined && inputs.reference === inputs.invoiceReference;

  if (referenceKnown && inputs.invoiceReference !== undefined && !referenceMatches) {
    breaks.push({
      type: "WRONG_REFERENCE",
      expected: inputs.expected,
      received: inputs.actual,
      detail: `Credit reference "${inputs.reference}" does not match expected invoice reference "${inputs.invoiceReference}".`,
    });
  }

  if (isZero(inputs.actual)) {
    breaks.push({
      type: "MISSING_CREDIT",
      expected: inputs.expected,
      detail: "No INR credit was received against this invoice.",
    });
  } else {
    const cmp = compare(inputs.actual, inputs.expected);
    if (cmp < 0) {
      breaks.push({
        type: "SHORT_PAYMENT",
        expected: inputs.expected,
        received: inputs.actual,
        detail: `Received ₹${subtract(inputs.expected, inputs.actual).amountMinor.toString()} minor units less than expected.${inputs.deductingHopId ? ` Deducted at hop "${inputs.deductingHopId}".` : ""}`,
        deductingHopId: inputs.deductingHopId,
      });
    } else if (cmp > 0) {
      breaks.push({
        type: "OVERPAYMENT",
        expected: inputs.expected,
        received: inputs.actual,
        detail: `Received ₹${subtract(inputs.actual, inputs.expected).amountMinor.toString()} minor units more than expected.`,
      });
    }
  }

  const matched = breaks.length === 0;

  if (matched) {
    return {
      matched,
      breaks,
      eBrcLike: {
        label: "SIMULATED — NOT A DGFT/BANK DOCUMENT",
        invoiceId: inputs.invoice.invoiceId,
        amount: inputs.actual,
        issuedAt: inputs.landedAt,
      },
      firaLike: {
        label: "SIMULATED — NOT A DGFT/BANK DOCUMENT",
        invoiceId: inputs.invoice.invoiceId,
        amount: inputs.actual,
        issuedAt: inputs.landedAt,
      },
    };
  }

  return { matched, breaks };
}
