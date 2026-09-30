import { sealBundle } from "@corridoros/audit";
import { createHash } from "node:crypto";
import { FixedClock, idempotencyKey, workflowId as newWorkflowId } from "@corridoros/core";
import { evaluateCompliance, type ComplianceContext } from "@corridoros/compliance";
import type {
  Actor,
  AuditBundle,
  Bank,
  Buyer,
  ComplianceResult,
  Exporter,
  FailureInjection,
  Invoice,
  OptimizerCandidate,
  OptimizerResult,
  Quote,
  ReconResult,
  RouteId,
  SettlementResult,
  WorkflowEvent,
  WorkflowState,
} from "@corridoros/domain";
import { loadOptimizerProfile, optimize } from "@corridoros/optimizer";
import { RatesSim } from "@corridoros/rates-sim";
import { reconcile } from "@corridoros/recon";
import { createRouteRegistry, type RouteContext } from "@corridoros/routes";
import type { TokenizedConfigOverrides } from "@corridoros/routes";
import { EventStore } from "./eventStore.js";

export interface WorkflowInputs {
  invoice: Invoice;
  exporter: Exporter;
  buyer: Buyer;
  buyerBank: Bank;
  exporterBank: Bank;
  /** ISO instant the invoice is submitted — seeds the FixedClock for the whole run. */
  submittedAt: string;
  ratesSeed: string;
  optimizerProfile?: string;
  routeFailureInjection?: Partial<Record<RouteId, FailureInjection>>;
  tokenizedConfigOverrides?: TokenizedConfigOverrides;
  /** If a compliance hold is raised, whether a human approves it in this run. */
  autoApproveComplianceHold?: boolean;
  existingInvoiceNumbers?: string[];
}

export interface WorkflowRunResult {
  workflowId: string;
  finalState: WorkflowState;
  events: WorkflowEvent[];
  complianceResult: ComplianceResult;
  optimizerResult: OptimizerResult | null;
  chosenRouteId: RouteId | null;
  settlementAttempts: { routeId: RouteId; result: SettlementResult }[];
  reconResult: ReconResult | null;
  auditBundle: AuditBundle | null;
}

const SYSTEM_ACTOR: Actor = { type: "system", id: "corridoros-orchestrator" };
const MAX_SETTLEMENT_ATTEMPTS = 3;

function invoiceHash(invoice: Invoice): string {
  return createHash("sha256").update(JSON.stringify(invoice)).digest("hex");
}

/**
 * Runs one invoice through the full CorridorOS workflow (CLAUDE.md §4), wiring together
 * compliance, routes, the optimizer, ledger settlement, reconciliation and the audit bundle.
 * This is the orchestration layer on top of the pure state machine in machine.ts.
 */
export async function runWorkflow(inputs: WorkflowInputs): Promise<WorkflowRunResult> {
  const clock = new FixedClock(inputs.submittedAt);
  const store = new EventStore();
  const wfId = newWorkflowId();
  const rates = new RatesSim({ seed: inputs.ratesSeed });
  const routes = createRouteRegistry();

  const emit = <T>(type: string, payload: T, actor: Actor = SYSTEM_ACTOR, salt = "") =>
    store.append(wfId, type, payload, actor, idempotencyKey(wfId, type, salt), clock);

  const empty = (finalState: WorkflowState, complianceResult: ComplianceResult): WorkflowRunResult => ({
    workflowId: wfId,
    finalState,
    events: store.getEvents(wfId),
    complianceResult,
    optimizerResult: null,
    chosenRouteId: null,
    settlementAttempts: [],
    reconResult: null,
    auditBundle: null,
  });

  emit("INVOICE_SUBMITTED", { invoiceId: inputs.invoice.invoiceId, invoiceNumber: inputs.invoice.invoiceNumber });

  const complianceCtx: ComplianceContext = {
    invoice: inputs.invoice,
    exporter: inputs.exporter,
    buyer: inputs.buyer,
    existingInvoiceNumbers: inputs.existingInvoiceNumbers ?? [],
  };
  const complianceResult = evaluateCompliance(complianceCtx);

  const integrityBlocked = complianceResult.decisions.some(
    (d) => d.ruleId.startsWith("invoice.integrity.") && d.outcome === "BLOCK",
  );
  if (integrityBlocked) {
    emit("INVOICE_REJECTED", { decisions: complianceResult.decisions.filter((d) => d.outcome === "BLOCK") });
    return empty("INVOICE_REJECTED", complianceResult);
  }
  emit("INVOICE_VERIFIED", {});

  const nonIntegrityBlocked = complianceResult.decisions.some(
    (d) => !d.ruleId.startsWith("invoice.integrity.") && d.severity === "BLOCK" && d.outcome === "BLOCK",
  );
  const needsHold = nonIntegrityBlocked || complianceResult.reviewRequired;

  if (needsHold) {
    emit("COMPLIANCE_HOLD", { decisions: complianceResult.decisions.filter((d) => d.outcome !== "PASS") });
    if (!inputs.autoApproveComplianceHold) {
      return empty("COMPLIANCE_HOLD", complianceResult);
    }
    emit("COMPLIANCE_CLEARED", { approvedBy: "human-reviewer" }, { type: "human", id: "compliance-officer-001" });
  } else {
    emit("COMPLIANCE_CLEARED", {});
  }

  const allQuotes: Quote[] = [];
  const excludedRoutes = new Set<RouteId>();
  const settlementAttempts: { routeId: RouteId; result: SettlementResult }[] = [];
  let optimizerResult: OptimizerResult | null = null;
  let chosenRouteId: RouteId | null = null;
  let chosenQuote: Quote | null = null;
  let finalSettlement: SettlementResult | null = null;

  for (let attempt = 0; attempt < MAX_SETTLEMENT_ATTEMPTS; attempt++) {
    emit("ROUTES_QUOTED", { attempt }, SYSTEM_ACTOR, String(attempt));

    const candidates: OptimizerCandidate[] = [];
    const gated: { routeId: RouteId; reasons: string[] }[] = [];

    for (const routeId of Object.keys(routes) as RouteId[]) {
      if (excludedRoutes.has(routeId)) {
        gated.push({ routeId, reasons: ["Excluded after a failed settlement attempt earlier in this workflow run."] });
        continue;
      }
      const route = routes[routeId];
      const ctx: RouteContext = {
        invoice: inputs.invoice,
        buyerBank: inputs.buyerBank,
        exporterBank: inputs.exporterBank,
        rates,
        failureInjection: inputs.routeFailureInjection?.[routeId],
        configOverrides: { tokenized: inputs.tokenizedConfigOverrides },
      };
      const eligibility = route.checkEligibility(ctx);
      if (!eligibility.eligible) {
        gated.push({ routeId, reasons: eligibility.reasons });
        continue;
      }
      const quote = await route.quote(ctx, clock);
      allQuotes.push(quote);
      candidates.push({ quote, complianceRisk: complianceResult.residualRiskScore });
    }

    const { weights, name } = loadOptimizerProfile(inputs.optimizerProfile);
    optimizerResult = optimize(candidates, weights, name, gated);

    if (optimizerResult.ranked.length === 0) {
      // No eligible route at all — seal what we have as a failed workflow and stop.
      return empty("ROUTES_QUOTED", complianceResult);
    }

    const top = optimizerResult.ranked[0]!;
    chosenRouteId = top.routeId;
    chosenQuote = top.quote;

    emit("ROUTE_SELECTED", { routeId: chosenRouteId, quoteId: chosenQuote.quoteId, explanation: top.explanation });
    emit("FX_LOCKED", { quoteId: chosenQuote.quoteId, appliedRate: chosenQuote.appliedRate.rate, expiresAt: chosenQuote.expiresAt });
    emit("SETTLEMENT_INITIATED", { routeId: chosenRouteId }, SYSTEM_ACTOR, String(attempt));

    const settleCtx: RouteContext = {
      invoice: inputs.invoice,
      buyerBank: inputs.buyerBank,
      exporterBank: inputs.exporterBank,
      rates,
      failureInjection: inputs.routeFailureInjection?.[chosenRouteId],
      configOverrides: { tokenized: inputs.tokenizedConfigOverrides },
    };
    const settlement = await routes[chosenRouteId].settle(settleCtx, chosenQuote, clock);
    settlementAttempts.push({ routeId: chosenRouteId, result: settlement });

    if (settlement.status === "FAILED") {
      emit("REROUTING", { failedRouteId: chosenRouteId, reason: settlement.failureReason }, SYSTEM_ACTOR, String(attempt));
      excludedRoutes.add(chosenRouteId);
      chosenRouteId = null;
      chosenQuote = null;
      continue; // fresh quote + fresh FX lock on the next loop iteration, per CLAUDE.md §4
    }

    finalSettlement = settlement;
    emit("SETTLED", { ref: settlement.ref });
    break;
  }

  if (!finalSettlement || !chosenRouteId || !chosenQuote) {
    return {
      workflowId: wfId,
      finalState: store.getState(wfId),
      events: store.getEvents(wfId),
      complianceResult,
      optimizerResult,
      chosenRouteId: null,
      settlementAttempts,
      reconResult: null,
      auditBundle: null,
    };
  }

  emit("INR_PAYOUT_INITIATED", {});
  emit("INR_LANDED", { landedAt: finalSettlement.landedAt });

  const expected = chosenQuote.netInrLanded;
  const actual = finalSettlement.actualLandedInr ?? chosenQuote.netInrLanded;
  const reconResult = reconcile({
    invoice: inputs.invoice,
    expected,
    actual,
    deductingHopId: finalSettlement.deductingHopId,
    landedAt: finalSettlement.landedAt ?? clock.now().toISOString(),
  });

  // The diagram always passes through RECONCILED; a break diverts further into RECON_EXCEPTION
  // (CLAUDE.md §4: "RECONCILED ── (break) → RECON_EXCEPTION").
  emit("RECONCILED", { matched: reconResult.matched });
  if (reconResult.breaks.length > 0) {
    emit("RECON_EXCEPTION", { breaks: reconResult.breaks });
  }

  const auditBundle = sealBundle({
    workflowId: wfId,
    invoiceHash: invoiceHash(inputs.invoice),
    complianceDecisions: complianceResult.decisions,
    allQuotes,
    optimizerResult: optimizerResult!,
    chosenRouteId,
    settlementRefs: settlementAttempts.map((a) => a.result.ref),
    payoutRef: finalSettlement.ref,
    reconResult,
    events: store.getEvents(wfId),
    sealedAt: clock.now().toISOString(),
  });
  emit("AUDIT_SEALED", { chainHead: auditBundle.chainHead });

  return {
    workflowId: wfId,
    finalState: store.getState(wfId),
    events: store.getEvents(wfId),
    complianceResult,
    optimizerResult,
    chosenRouteId,
    settlementAttempts,
    reconResult,
    auditBundle,
  };
}
