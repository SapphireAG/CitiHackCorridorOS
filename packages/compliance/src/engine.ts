import { createHash } from "node:crypto";
import { loadJsonFile, loadYamlFile } from "@corridoros/core";
import type { Buyer, ComplianceDecision, ComplianceResult, Exporter, Invoice } from "@corridoros/domain";
import { similarity } from "./fuzzy.js";

interface RulesConfig {
  rules: {
    id: string;
    version: number;
    severity: "BLOCK" | "REVIEW" | "INFO";
    description: string;
    match_threshold?: number;
    round_amount_threshold_minor?: string;
  }[];
}

interface SanctionsList {
  entries: { name: string; list: string; reason: string }[];
}

interface RestrictedHsCodes {
  hs_codes: string[];
}

interface RegulatoryConfig {
  purpose_codes: Record<string, { code: string; label: string; unverified: boolean }>;
  realisation_period: { export_proceeds: { months: number; unverified: boolean } };
}

function inputsHash(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function rule(rules: RulesConfig, id: string) {
  const found = rules.rules.find((r) => r.id === id);
  if (!found) throw new Error(`Missing compliance rule config: ${id}`);
  return found;
}

const IEC_FORMAT = /^SYNIEC\d{4}$/;
const GSTIN_FORMAT = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN_FORMAT = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export interface ComplianceContext {
  invoice: Invoice;
  exporter: Exporter;
  buyer: Buyer;
  /** Invoice numbers already on file for this exporter, to detect duplicates. */
  existingInvoiceNumbers?: string[];
  /** Historical volume for this exporter, for the velocity heuristic. */
  exporterRecentInvoiceCount?: number;
}

/**
 * Simulated compliance engine (CLAUDE.md §9). Pure function of its inputs plus the bundled
 * config/data fixtures — no network calls, no real screening service. BLOCK removes a route
 * from consideration entirely (never outscored); REVIEW holds the workflow for a human; INFO
 * is recorded but never gates.
 */
export function evaluateCompliance(ctx: ComplianceContext): ComplianceResult {
  const rulesConfig = loadYamlFile<RulesConfig>("config/compliance/rules.yaml");
  const sanctions = loadJsonFile<SanctionsList>("data/sanctions_sample.json");
  const restrictedHs = loadJsonFile<RestrictedHsCodes>("data/restricted_hs_codes.json");
  const regulatory = loadYamlFile<RegulatoryConfig>("config/regulatory.yaml");

  const decisions: ComplianceDecision[] = [];

  // 1. Invoice integrity: required fields + totals add up.
  {
    const r = rule(rulesConfig, "invoice.integrity.required_fields");
    const hasFields =
      !!ctx.invoice.invoiceNumber && !!ctx.invoice.exporterId && !!ctx.invoice.buyerId && ctx.invoice.lineItems.length > 0;
    const sumMinor = ctx.invoice.lineItems.reduce(
      (acc, li) => acc + BigInt(li.unitPriceMinor) * BigInt(li.quantity),
      0n,
    );
    const totalsMatch = sumMinor === BigInt(ctx.invoice.totalMinor);
    const pass = hasFields && totalsMatch;
    decisions.push({
      ruleId: r.id,
      version: r.version,
      severity: r.severity,
      outcome: pass ? "PASS" : "BLOCK",
      reason: pass
        ? "Invoice has required fields and line-item totals reconcile to the stated total."
        : !hasFields
          ? "Invoice is missing a required field."
          : `Line items sum to ${sumMinor.toString()} minor units but invoice states ${ctx.invoice.totalMinor}.`,
      inputsHash: inputsHash({ invoice: ctx.invoice }),
    });
  }

  // 2. No duplicate invoice number for this exporter.
  {
    const r = rule(rulesConfig, "invoice.integrity.no_duplicate");
    const isDuplicate = (ctx.existingInvoiceNumbers ?? []).includes(ctx.invoice.invoiceNumber);
    decisions.push({
      ruleId: r.id,
      version: r.version,
      severity: r.severity,
      outcome: isDuplicate ? "BLOCK" : "PASS",
      reason: isDuplicate
        ? `Invoice number ${ctx.invoice.invoiceNumber} already exists for exporter ${ctx.exporter.exporterId}.`
        : "Invoice number is unique for this exporter.",
      inputsHash: inputsHash({ invoiceNumber: ctx.invoice.invoiceNumber, exporterId: ctx.exporter.exporterId }),
    });
  }

  // 3. Exporter KYB: format + seeded registry + verified bank account.
  {
    const r = rule(rulesConfig, "exporter.kyb.format_and_registry");
    const formatOk = IEC_FORMAT.test(ctx.exporter.iec) && GSTIN_FORMAT.test(ctx.exporter.gstin) && PAN_FORMAT.test(ctx.exporter.pan);
    const pass = formatOk && ctx.exporter.verified;
    decisions.push({
      ruleId: r.id,
      version: r.version,
      severity: r.severity,
      outcome: pass ? "PASS" : "BLOCK",
      reason: pass
        ? "Exporter IEC/GSTIN/PAN pass format validation and the bank account is verified."
        : "Exporter failed IEC/GSTIN/PAN format validation or is not verified in the seeded registry.",
      inputsHash: inputsHash({ exporterId: ctx.exporter.exporterId }),
    });
  }

  // 4. Buyer KYB: seeded SG registry.
  {
    const r = rule(rulesConfig, "buyer.kyb.registry");
    const pass = ctx.buyer.registered;
    decisions.push({
      ruleId: r.id,
      version: r.version,
      severity: r.severity,
      outcome: pass ? "PASS" : "BLOCK",
      reason: pass ? "Buyer entity exists in the seeded SG registry." : "Buyer entity not found in the seeded SG registry.",
      inputsHash: inputsHash({ buyerId: ctx.buyer.buyerId }),
    });
  }

  // 5. Sanctions fuzzy match (sample list only).
  {
    const r = rule(rulesConfig, "sanctions.fuzzy_match");
    const threshold = r.match_threshold ?? 0.82;
    let bestMatch: { name: string; score: number } | null = null;
    for (const entry of sanctions.entries) {
      for (const candidateName of [ctx.exporter.name, ctx.buyer.name]) {
        const score = similarity(candidateName, entry.name);
        if (!bestMatch || score > bestMatch.score) bestMatch = { name: entry.name, score };
      }
    }
    const flagged = !!bestMatch && bestMatch.score >= threshold;
    decisions.push({
      ruleId: r.id,
      version: r.version,
      severity: r.severity,
      outcome: flagged ? "REVIEW" : "PASS",
      reason: flagged
        ? `Fuzzy match ${(bestMatch!.score * 100).toFixed(1)}% against sample list entry "${bestMatch!.name}" (threshold ${(threshold * 100).toFixed(0)}%). Sample list only — not a real screening service.`
        : "No fuzzy match above threshold against the bundled sample list.",
      inputsHash: inputsHash({ exporterName: ctx.exporter.name, buyerName: ctx.buyer.name }),
    });
  }

  // 6. Goods: restricted/dual-use HS code sample list.
  {
    const r = rule(rulesConfig, "goods.restricted_dual_use");
    const hits = ctx.invoice.lineItems.filter((li) => restrictedHs.hs_codes.includes(li.hsCode));
    decisions.push({
      ruleId: r.id,
      version: r.version,
      severity: r.severity,
      outcome: hits.length > 0 ? "REVIEW" : "PASS",
      reason:
        hits.length > 0
          ? `HS code(s) ${hits.map((h) => h.hsCode).join(", ")} appear on the sample restricted/dual-use list.`
          : "No line-item HS code appears on the sample restricted/dual-use list.",
      inputsHash: inputsHash({ hsCodes: ctx.invoice.lineItems.map((li) => li.hsCode) }),
    });
  }

  // 7. Purpose code assignment (INFO, never gates).
  {
    const r = rule(rulesConfig, "purpose_code.assignment");
    const entry = regulatory.purpose_codes[ctx.invoice.purpose];
    decisions.push({
      ruleId: r.id,
      version: r.version,
      severity: r.severity,
      outcome: "INFO",
      reason: entry
        ? `Purpose code ${entry.code} (${entry.label}) assigned${entry.unverified ? ", unverified against current RBI rule" : ""}.`
        : `No purpose code configured for "${ctx.invoice.purpose}".`,
      inputsHash: inputsHash({ purpose: ctx.invoice.purpose }),
    });
  }

  // 8. Realisation tracking (INFO, never gates).
  {
    const r = rule(rulesConfig, "realisation.tracking");
    const months = regulatory.realisation_period.export_proceeds.months;
    const shipDate = new Date(ctx.invoice.shipmentDate);
    const dueDate = new Date(shipDate);
    dueDate.setUTCMonth(dueDate.getUTCMonth() + months);
    decisions.push({
      ruleId: r.id,
      version: r.version,
      severity: r.severity,
      outcome: "INFO",
      reason: `Export proceeds realisation due by ${dueDate.toISOString().slice(0, 10)} (${months} months from shipment). unverified: true — confirm against the current RBI rule.`,
      inputsHash: inputsHash({ shipmentDate: ctx.invoice.shipmentDate, months }),
    });
  }

  // 9. Velocity / round-amount heuristic (REVIEW only, never BLOCK).
  {
    const r = rule(rulesConfig, "velocity.aml_heuristics");
    const total = BigInt(ctx.invoice.totalMinor);
    // Simplified heuristic for the demo: flag invoices that are an exact round number at
    // 1,000-major-unit granularity, regardless of currency.
    const roundGranularity = 100_000n; // 1,000 major units at a 2-decimal currency
    const isRoundAmount = total % roundGranularity === 0n;
    decisions.push({
      ruleId: r.id,
      version: r.version,
      severity: r.severity,
      outcome: isRoundAmount ? "REVIEW" : "PASS",
      reason: isRoundAmount
        ? "Invoice amount is an exact round figure, flagged for review as a velocity/AML heuristic (review only, never a block)."
        : "No velocity/round-amount heuristic triggered.",
      inputsHash: inputsHash({ totalMinor: ctx.invoice.totalMinor }),
    });
  }

  const blocked = decisions.some((d) => d.severity === "BLOCK" && d.outcome === "BLOCK");
  const reviewRequired = decisions.some((d) => d.severity === "REVIEW" && d.outcome === "REVIEW");
  const reviewCount = decisions.filter((d) => d.outcome === "REVIEW").length;
  const residualRiskScore = blocked ? 1 : Math.min(1, reviewCount * 0.2);

  return { decisions, blocked, reviewRequired, residualRiskScore };
}
