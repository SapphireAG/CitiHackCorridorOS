import { FixedClock, idempotencyKey } from "@corridoros/core";
import type { OptimizerResult } from "@corridoros/domain";
import { describe, expect, it } from "vitest";
import { sealBundle, verifyBundle } from "../src/bundle.js";
import { computeEventHash, verifyEventChain } from "../src/chain.js";

function buildEvents() {
  // Minimal hand-built hash-chained event log, mirroring what EventStore produces.
  const clock = new FixedClock("2026-01-01T00:00:00.000Z");
  const events = [];
  let prevHash = "GENESIS";
  const steps: [string, unknown][] = [
    ["INVOICE_SUBMITTED", {}],
    ["INVOICE_VERIFIED", {}],
    ["COMPLIANCE_CLEARED", {}],
  ];
  for (let seq = 0; seq < steps.length; seq++) {
    const [type, payload] = steps[seq]!;
    const base = {
      workflowId: "wf_test",
      seq,
      type,
      payload,
      actor: { type: "system" as const, id: "test" },
      at: clock.now().toISOString(),
      idempotencyKey: idempotencyKey("wf_test", type),
      prevHash,
    };
    const hash = computeEventHash(base);
    events.push({ ...base, hash });
    prevHash = hash;
  }
  return events;
}

const emptyOptimizerResult: OptimizerResult = { ranked: [], gated: [], profile: "balanced" };

describe("audit — hash chain and signature", () => {
  it("verifies a freshly sealed bundle", () => {
    const events = buildEvents();
    const bundle = sealBundle({
      workflowId: "wf_test",
      invoiceHash: "deadbeef",
      complianceDecisions: [],
      allQuotes: [],
      optimizerResult: emptyOptimizerResult,
      chosenRouteId: "CORRESPONDENT",
      settlementRefs: ["ref1"],
      payoutRef: "ref1",
      reconResult: null,
      events,
      sealedAt: "2026-01-01T01:00:00.000Z",
    });
    expect(verifyBundle(bundle, events).valid).toBe(true);
  });

  it("detects a tampered event payload — chain hash no longer matches", () => {
    const events = buildEvents();
    const bundle = sealBundle({
      workflowId: "wf_test",
      invoiceHash: "deadbeef",
      complianceDecisions: [],
      allQuotes: [],
      optimizerResult: emptyOptimizerResult,
      chosenRouteId: "CORRESPONDENT",
      settlementRefs: ["ref1"],
      payoutRef: "ref1",
      reconResult: null,
      events,
      sealedAt: "2026-01-01T01:00:00.000Z",
    });

    const tampered = events.map((e, i) => (i === 1 ? { ...e, payload: { tampered: true } } : e));
    const result = verifyBundle(bundle, tampered);
    expect(result.valid).toBe(false);
  });

  it("detects a tampered bundle field — signature no longer matches", () => {
    const events = buildEvents();
    const bundle = sealBundle({
      workflowId: "wf_test",
      invoiceHash: "deadbeef",
      complianceDecisions: [],
      allQuotes: [],
      optimizerResult: emptyOptimizerResult,
      chosenRouteId: "CORRESPONDENT",
      settlementRefs: ["ref1"],
      payoutRef: "ref1",
      reconResult: null,
      events,
      sealedAt: "2026-01-01T01:00:00.000Z",
    });

    const tamperedBundle = { ...bundle, payoutRef: "tampered-ref" };
    const result = verifyBundle(tamperedBundle, events);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/signature/i);
  });

  it("verifyEventChain reports the exact seq where the chain breaks", () => {
    const events = buildEvents();
    const tampered = events.map((e, i) => (i === 2 ? { ...e, hash: "0".repeat(64) } : e));
    const result = verifyEventChain(tampered);
    expect(result.valid).toBe(false);
    expect(result.brokenAtSeq).toBe(2);
  });
});
