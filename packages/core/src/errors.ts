/**
 * Typed errors. Never throw strings (CLAUDE.md §16) — every failure in CorridorOS is one
 * of these so callers can branch on `instanceof` rather than parsing messages.
 */

export abstract class CorridorError extends Error {
  abstract readonly code: string;

  constructor(message: string, readonly context: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
  }
}

export class CurrencyMismatchError extends CorridorError {
  readonly code = "CURRENCY_MISMATCH";
  constructor(a: string, b: string) {
    super(`Cannot operate on mismatched currencies: ${a} vs ${b}`, { a, b });
  }
}

export class ValidationError extends CorridorError {
  readonly code = "VALIDATION_ERROR";
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, context);
  }
}

export class UnknownCurrencyError extends CorridorError {
  readonly code = "UNKNOWN_CURRENCY";
  constructor(currency: string) {
    super(`Unknown currency: ${currency}. Add it to config/currencies.yaml.`, { currency });
  }
}

export class IllegalTransitionError extends CorridorError {
  readonly code = "ILLEGAL_TRANSITION";
  constructor(from: string, event: string) {
    super(`Illegal transition: cannot apply "${event}" from state "${from}"`, { from, event });
  }
}

export class QuoteExpiredError extends CorridorError {
  readonly code = "QUOTE_EXPIRED";
  constructor(routeId: string, expiresAt: string) {
    super(`Quote for route "${routeId}" expired at ${expiresAt}`, { routeId, expiresAt });
  }
}

export class NoEligibleRouteError extends CorridorError {
  readonly code = "NO_ELIGIBLE_ROUTE";
  constructor(reasons: Record<string, string[]>) {
    super("No route is eligible for this workflow", { reasons });
  }
}

export class ComplianceBlockedError extends CorridorError {
  readonly code = "COMPLIANCE_BLOCKED";
  constructor(ruleIds: string[]) {
    super(`Compliance BLOCK on rule(s): ${ruleIds.join(", ")}`, { ruleIds });
  }
}

export class AuditChainTamperedError extends CorridorError {
  readonly code = "AUDIT_CHAIN_TAMPERED";
  constructor(atSeq: number) {
    super(`Audit hash chain broken at seq ${atSeq}`, { atSeq });
  }
}
