import type { FxRate, Money } from "@corridoros/core";

/**
 * Shared domain types, used across compliance/routes/optimizer/workflow/recon/audit.
 * Structural note: CLAUDE.md §11 does not list a `domain` package explicitly; it was added
 * here to hold cross-cutting type contracts (Invoice, Quote, WorkflowEvent, ...) without
 * creating circular dependencies between `routes`, `optimizer`, `workflow`, `compliance`,
 * `recon` and `audit`. It has no runtime logic of its own, only types.
 */

export type RouteId = "CORRESPONDENT" | "TOKENIZED";

// ---- Parties (all SYNTHETIC — CLAUDE.md §2.5) ----------------------------------------------

export interface Exporter {
  exporterId: string;
  name: string;
  iec: string;
  gstin: string;
  pan: string;
  bankAccountId: string;
  country: "IN";
  verified: boolean;
}

export interface Buyer {
  buyerId: string;
  name: string;
  country: "SG";
  bankId: string;
  registered: boolean;
}

export interface Bank {
  bankId: string;
  name: string;
  country: string;
  tokenizedNetworkMember: boolean;
  adCategory?: string;
}

// ---- Invoice ---------------------------------------------------------------------------------

export interface InvoiceLineItem {
  description: string;
  hsCode: string;
  quantity: number;
  unitPriceMinor: string; // minor units, source currency
}

export interface Invoice {
  invoiceId: string;
  invoiceNumber: string;
  exporterId: string;
  buyerId: string;
  currency: "SGD" | "USD";
  totalMinor: string; // minor units, invoice currency — sum of line items
  lineItems: InvoiceLineItem[];
  invoiceDate: string; // ISO date
  shipmentDate: string; // ISO date
  purpose: "export_of_goods" | "advance_receipt";
}

// ---- Compliance --------------------------------------------------------------------------------

export type ComplianceSeverity = "BLOCK" | "REVIEW" | "INFO";
export type ComplianceOutcome = "PASS" | "BLOCK" | "REVIEW" | "INFO";

export interface ComplianceDecision {
  ruleId: string;
  version: number;
  severity: ComplianceSeverity;
  outcome: ComplianceOutcome;
  reason: string;
  inputsHash: string;
}

export interface ComplianceResult {
  decisions: ComplianceDecision[];
  blocked: boolean;
  reviewRequired: boolean;
  /** Residual risk score 0-1 for routes/optimizer to consume, only meaningful when not blocked. */
  residualRiskScore: number;
}

// ---- Eligibility / Quote / Settlement (Route interface, CLAUDE.md §6) -----------------------

export interface EligibilityResult {
  eligible: boolean;
  reasons: string[];
}

export interface Quote {
  routeId: RouteId;
  quoteId: string;
  midRate: FxRate;
  appliedRate: FxRate;
  feesInr: Money;
  fxSpreadBps: number;
  allInCostBps: number;
  netInrLanded: Money;
  timeToLandedMinutes: number;
  estimatedLandedAt: string; // ISO instant
  expiresAt: string; // ISO instant
  liquidityCertainty: number; // 0-1
  explainFacts: Record<string, string>; // structured facts for the human-readable explanation
}

export type SettlementStatus = "PENDING" | "SOFT" | "FINAL" | "FAILED";

export interface SettlementResult {
  status: SettlementStatus;
  ref: string;
  routeId: RouteId;
  failureReason?: string;
  landedAt?: string; // ISO instant, present once FINAL
  /** Actual INR credited — may differ from the quote's netInrLanded (e.g. a short payment). */
  actualLandedInr?: Money;
  /** Hop id that caused a short payment, when applicable (correspondent route only). */
  deductingHopId?: string;
  messages?: { type: string; messageId: string }[];
}

export type FailureInjection =
  | { mode: "return" }
  | { mode: "delay"; minutes: number }
  | { mode: "intermediary_deduction"; hopId: string; extraFeeMinor: string }
  | { mode: "missing_remittance_info" }
  | { mode: "insufficient_liquidity" }
  | { mode: "participant_offline" }
  | { mode: "ledger_reject" }
  | { mode: "payout_delay"; minutes: number };

// ---- Optimizer -----------------------------------------------------------------------------

export interface OptimizerCandidate {
  quote: Quote;
  complianceRisk: number; // 0-1, residual risk from the compliance engine
}

export interface OptimizerMetrics {
  feesInr: Money;
  fxSpreadBps: number;
  allInCostBps: number;
  netInrLanded: Money;
  timeToLandedMinutes: number;
  liquidityCertainty: number;
  complianceRisk: number;
}

export interface OptimizerRanking {
  routeId: RouteId;
  quote: Quote;
  metrics: OptimizerMetrics;
  normalizedScores: { cost: number; time: number; liquidity: number; compliance: number };
  weightedScore: number;
  explanation: string;
}

export interface OptimizerResult {
  ranked: OptimizerRanking[];
  gated: { routeId: RouteId; reasons: string[] }[];
  profile: string;
}

// ---- Workflow state machine (CLAUDE.md §4) --------------------------------------------------

export type WorkflowState =
  | "DRAFT"
  | "INVOICE_SUBMITTED"
  | "INVOICE_VERIFIED"
  | "INVOICE_REJECTED"
  | "COMPLIANCE_CLEARED"
  | "COMPLIANCE_HOLD"
  | "ROUTES_QUOTED"
  | "ROUTE_SELECTED"
  | "FX_LOCKED"
  | "SETTLEMENT_INITIATED"
  | "SETTLED"
  | "REROUTING"
  | "INR_PAYOUT_INITIATED"
  | "INR_LANDED"
  | "RECONCILED"
  | "RECON_EXCEPTION"
  | "AUDIT_SEALED";

export interface Actor {
  type: "system" | "human";
  id: string;
}

export interface WorkflowEvent<TPayload = unknown> {
  workflowId: string;
  seq: number;
  type: string;
  payload: TPayload;
  actor: Actor;
  at: string; // ISO instant
  idempotencyKey: string;
  prevHash: string;
  hash: string;
}

// ---- Reconciliation (CLAUDE.md §10.1) -------------------------------------------------------

export type ReconBreakType = "SHORT_PAYMENT" | "OVERPAYMENT" | "MISSING_CREDIT" | "DUPLICATE_CREDIT" | "WRONG_REFERENCE";

export interface ReconBreak {
  type: ReconBreakType;
  expected: Money;
  received?: Money;
  detail: string;
  deductingHopId?: string;
}

export interface ReconResult {
  matched: boolean;
  breaks: ReconBreak[];
  eBrcLike?: { label: string; invoiceId: string; amount: Money; issuedAt: string };
  firaLike?: { label: string; invoiceId: string; amount: Money; issuedAt: string };
}

// ---- Audit (CLAUDE.md §10.2) -----------------------------------------------------------------

export interface AuditBundle {
  workflowId: string;
  invoiceHash: string;
  complianceDecisions: ComplianceDecision[];
  allQuotes: Quote[];
  optimizerResult: OptimizerResult;
  chosenRouteId: RouteId;
  settlementRefs: string[];
  payoutRef: string | null;
  reconResult: ReconResult | null;
  chainHead: string;
  sealedAt: string;
  signature: string;
  publicKey: string;
}
