import { compare, toMajorUnitsString } from "@corridoros/core";
import type { OptimizerCandidate, OptimizerMetrics, OptimizerRanking, OptimizerResult, RouteId } from "@corridoros/domain";
import type { ProfileWeights } from "./profiles.js";

function normalize(values: number[], direction: "lowerBetter" | "higherBetter"): number[] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return values.map(() => 1);
  return values.map((v) => {
    const scaled = (v - min) / (max - min); // 0 = lowest value, 1 = highest value
    return direction === "higherBetter" ? scaled : 1 - scaled;
  });
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 60 * 24) return `${(minutes / 60).toFixed(1)} hours`;
  return `${(minutes / (60 * 24)).toFixed(1)} days`;
}

function explain(
  top: { routeId: RouteId; metrics: OptimizerMetrics },
  runnerUp: { routeId: RouteId; metrics: OptimizerMetrics } | undefined,
  gated: { routeId: RouteId; reasons: string[] }[],
): string {
  const parts: string[] = [];
  if (runnerUp) {
    const moneyDeltaMinor = top.metrics.netInrLanded.amountMinor - runnerUp.metrics.netInrLanded.amountMinor;
    const timeDeltaMinutes = runnerUp.metrics.timeToLandedMinutes - top.metrics.timeToLandedMinutes;
    const moneyPart =
      moneyDeltaMinor > 0n
        ? `lands ₹${toMajorUnitsString({ amountMinor: moneyDeltaMinor, currency: "INR" })} more`
        : moneyDeltaMinor < 0n
          ? `lands ₹${toMajorUnitsString({ amountMinor: -moneyDeltaMinor, currency: "INR" })} less`
          : `lands the same net INR`;
    const timePart =
      timeDeltaMinutes > 0
        ? `${formatMinutes(timeDeltaMinutes)} sooner`
        : timeDeltaMinutes < 0
          ? `${formatMinutes(-timeDeltaMinutes)} later`
          : `in the same time`;
    parts.push(`${top.routeId} ${moneyPart} and ${timePart} than ${runnerUp.routeId}.`);
  } else {
    parts.push(`${top.routeId} is the only eligible route for this workflow.`);
  }
  for (const g of gated) {
    if (g.reasons.length > 0) {
      parts.push(`${g.routeId} was not eligible: ${g.reasons[0]}`);
    }
  }
  return parts.join(" ");
}

/**
 * Pure optimizer (CLAUDE.md §7): (candidates, weights) -> ranked list + breakdown. No I/O, no
 * clock. Gating (compliance/eligibility) must already have happened before candidates reach
 * here — a gated route is passed separately in `gated` for UI/explanation purposes only, and
 * never appears in `ranked`.
 */
export function optimize(
  candidates: OptimizerCandidate[],
  weights: ProfileWeights,
  profileName: string,
  gated: { routeId: RouteId; reasons: string[] }[] = [],
): OptimizerResult {
  if (candidates.length === 0) {
    return { ranked: [], gated, profile: profileName };
  }

  const metricsList: OptimizerMetrics[] = candidates.map((c) => ({
    feesInr: c.quote.feesInr,
    fxSpreadBps: c.quote.fxSpreadBps,
    allInCostBps: c.quote.allInCostBps,
    netInrLanded: c.quote.netInrLanded,
    timeToLandedMinutes: c.quote.timeToLandedMinutes,
    liquidityCertainty: c.quote.liquidityCertainty,
    complianceRisk: c.complianceRisk,
  }));

  const costScores = normalize(metricsList.map((m) => m.allInCostBps), "lowerBetter");
  const timeScores = normalize(metricsList.map((m) => m.timeToLandedMinutes), "lowerBetter");
  const liquidityScores = normalize(metricsList.map((m) => m.liquidityCertainty), "higherBetter");
  const complianceScores = normalize(metricsList.map((m) => m.complianceRisk), "lowerBetter");

  const totalWeight = weights.cost + weights.time + weights.liquidity + weights.compliance || 1;

  const draft = candidates.map((c, i) => {
    const normalizedScores = {
      cost: costScores[i]!,
      time: timeScores[i]!,
      liquidity: liquidityScores[i]!,
      compliance: complianceScores[i]!,
    };
    const weightedScore =
      (normalizedScores.cost * weights.cost +
        normalizedScores.time * weights.time +
        normalizedScores.liquidity * weights.liquidity +
        normalizedScores.compliance * weights.compliance) /
      totalWeight;
    return {
      routeId: c.quote.routeId,
      quote: c.quote,
      metrics: metricsList[i]!,
      normalizedScores,
      weightedScore,
    };
  });

  draft.sort((a, b) => {
    if (b.weightedScore !== a.weightedScore) return b.weightedScore - a.weightedScore;
    const moneyCmp = compare(b.metrics.netInrLanded, a.metrics.netInrLanded);
    if (moneyCmp !== 0) return moneyCmp;
    if (a.metrics.timeToLandedMinutes !== b.metrics.timeToLandedMinutes) {
      return a.metrics.timeToLandedMinutes - b.metrics.timeToLandedMinutes;
    }
    return a.routeId.localeCompare(b.routeId);
  });

  const ranked: OptimizerRanking[] = draft.map((d, i) => ({
    ...d,
    explanation: explain(d, draft[i + 1], gated),
  }));

  return { ranked, gated, profile: profileName };
}
