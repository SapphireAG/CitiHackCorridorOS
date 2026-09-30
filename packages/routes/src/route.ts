import type { Clock } from "@corridoros/core";
import type { Bank, EligibilityResult, FailureInjection, Invoice, Quote, RouteId, SettlementResult } from "@corridoros/domain";
import type { RatesSim } from "@corridoros/rates-sim";

export interface RouteContext {
  invoice: Invoice;
  buyerBank: Bank;
  exporterBank: Bank;
  rates: RatesSim;
  failureInjection?: FailureInjection;
  /** Scenario-level overrides for route config (e.g. a thin tokenized liquidity pool). */
  configOverrides?: {
    tokenized?: import("./tokenized/config.js").TokenizedConfigOverrides;
  };
}

/** The Route interface every route (correspondent, tokenized, ...) implements — CLAUDE.md §6. */
export interface Route {
  readonly id: RouteId;
  checkEligibility(ctx: RouteContext): EligibilityResult;
  quote(ctx: RouteContext, clock: Clock): Promise<Quote>;
  settle(ctx: RouteContext, quote: Quote, clock: Clock): Promise<SettlementResult>;
}
