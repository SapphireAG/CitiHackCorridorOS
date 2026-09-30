import { describe, expect, it } from "vitest";
import type { OptimizerCandidate, Quote } from "@corridoros/domain";
import { optimize } from "../src/optimize.js";
import { loadOptimizerProfile } from "../src/profiles.js";

function makeQuote(overrides: Partial<Quote> & { routeId: Quote["routeId"] }): Quote {
  return {
    quoteId: `quote-${overrides.routeId}`,
    midRate: { base: "SGD", quote: "INR", rate: "63.15000000" },
    appliedRate: { base: "SGD", quote: "INR", rate: "63.00000000" },
    feesInr: { amountMinor: 1000n, currency: "INR" },
    fxSpreadBps: 100,
    allInCostBps: 100,
    netInrLanded: { amountMinor: 79_000_000n, currency: "INR" },
    timeToLandedMinutes: 100,
    estimatedLandedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T01:00:00.000Z",
    liquidityCertainty: 0.9,
    explainFacts: {},
    ...overrides,
  };
}

// A cheaper-but-slower correspondent-shaped quote vs a faster-but-pricier tokenized-shaped one,
// so "cheapest" and "fastest" profiles are expected to disagree on the winner.
const cheapSlow = makeQuote({ routeId: "CORRESPONDENT", allInCostBps: 50, timeToLandedMinutes: 4000, netInrLanded: { amountMinor: 80_000_000n, currency: "INR" } });
const pricyFast = makeQuote({ routeId: "TOKENIZED", allInCostBps: 300, timeToLandedMinutes: 100, netInrLanded: { amountMinor: 77_000_000n, currency: "INR" } });

function candidates(): OptimizerCandidate[] {
  return [
    { quote: cheapSlow, complianceRisk: 0 },
    { quote: pricyFast, complianceRisk: 0 },
  ];
}

describe("optimizer — gating", () => {
  it("a gated route never appears in the ranked list", () => {
    const { weights, name } = loadOptimizerProfile("balanced");
    const result = optimize([{ quote: cheapSlow, complianceRisk: 0 }], weights, name, [
      { routeId: "TOKENIZED", reasons: ["not eligible"] },
    ]);
    expect(result.ranked.map((r) => r.routeId)).not.toContain("TOKENIZED");
    expect(result.gated.map((g) => g.routeId)).toContain("TOKENIZED");
  });
});

describe("optimizer — determinism", () => {
  it("same input always produces the same output, including tie-break order", () => {
    const { weights, name } = loadOptimizerProfile("balanced");
    const a = optimize(candidates(), weights, name);
    const b = optimize(candidates(), weights, name);
    expect(a.ranked.map((r) => r.routeId)).toEqual(b.ranked.map((r) => r.routeId));
    expect(a.ranked.map((r) => r.weightedScore)).toEqual(b.ranked.map((r) => r.weightedScore));
  });

  it("ties break on netInrLanded, then timeToLandedMinutes, then routeId", () => {
    const identicalA = makeQuote({ routeId: "TOKENIZED" });
    const identicalB = makeQuote({ routeId: "CORRESPONDENT" });
    const { weights, name } = loadOptimizerProfile("balanced");
    const result = optimize(
      [
        { quote: identicalA, complianceRisk: 0 },
        { quote: identicalB, complianceRisk: 0 },
      ],
      weights,
      name,
    );
    // Identical metrics -> identical weighted score -> tie-break alphabetically by routeId.
    expect(result.ranked[0]!.routeId).toBe("CORRESPONDENT");
    expect(result.ranked[1]!.routeId).toBe("TOKENIZED");
  });
});

describe("optimizer — profiles golden tests", () => {
  it("'cheapest' profile favors the lower-cost route", () => {
    const { weights, name } = loadOptimizerProfile("cheapest");
    const result = optimize(candidates(), weights, name);
    expect(result.ranked[0]!.routeId).toBe("CORRESPONDENT");
  });

  it("'fastest' profile favors the quicker route", () => {
    const { weights, name } = loadOptimizerProfile("fastest");
    const result = optimize(candidates(), weights, name);
    expect(result.ranked[0]!.routeId).toBe("TOKENIZED");
  });
});
