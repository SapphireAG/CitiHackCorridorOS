import { IllegalTransitionError } from "@corridoros/core";
import type { WorkflowEvent, WorkflowState } from "@corridoros/domain";

/**
 * Explicit transition table — CLAUDE.md §4. Event type == target state name; each key lists
 * the states reachable directly from it. Deviation from the diagram, documented: RECON_EXCEPTION
 * -> AUDIT_SEALED is added so a workflow that lands in exception still produces a sealed audit
 * trail (the diagram leaves this open; sealing regardless of recon outcome is more useful for a
 * demo/audit trail than leaving RECON_EXCEPTION as a dead end).
 */
export const TRANSITIONS: Record<WorkflowState, WorkflowState[]> = {
  DRAFT: ["INVOICE_SUBMITTED"],
  INVOICE_SUBMITTED: ["INVOICE_VERIFIED", "INVOICE_REJECTED"],
  INVOICE_VERIFIED: ["COMPLIANCE_CLEARED", "COMPLIANCE_HOLD"],
  INVOICE_REJECTED: [],
  COMPLIANCE_HOLD: ["COMPLIANCE_CLEARED"],
  COMPLIANCE_CLEARED: ["ROUTES_QUOTED"],
  ROUTES_QUOTED: ["ROUTE_SELECTED"],
  ROUTE_SELECTED: ["FX_LOCKED"],
  FX_LOCKED: ["SETTLEMENT_INITIATED", "ROUTES_QUOTED"],
  SETTLEMENT_INITIATED: ["SETTLED", "REROUTING"],
  REROUTING: ["ROUTES_QUOTED"],
  SETTLED: ["INR_PAYOUT_INITIATED"],
  INR_PAYOUT_INITIATED: ["INR_LANDED"],
  INR_LANDED: ["RECONCILED"],
  RECONCILED: ["RECON_EXCEPTION", "AUDIT_SEALED"],
  RECON_EXCEPTION: ["AUDIT_SEALED"],
  AUDIT_SEALED: [],
};

export function applyTransition(from: WorkflowState, to: WorkflowState): WorkflowState {
  const allowed = TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) throw new IllegalTransitionError(from, to);
  return to;
}

/** State is derived from the event log, never stored as a mutable column (CLAUDE.md §4). */
export function deriveState(events: WorkflowEvent[]): WorkflowState {
  let state: WorkflowState = "DRAFT";
  for (const event of events) {
    state = applyTransition(state, event.type as WorkflowState);
  }
  return state;
}
