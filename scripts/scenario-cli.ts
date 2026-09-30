#!/usr/bin/env tsx
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadJsonFile, repoPath, toMajorUnitsString } from "@corridoros/core";
import type { Bank, Buyer, Exporter, Invoice, RouteId } from "@corridoros/domain";
import { toPlainJson } from "@corridoros/audit";
import { runWorkflow, type WorkflowInputs, type WorkflowRunResult } from "@corridoros/workflow";
import type { TokenizedConfigOverrides } from "@corridoros/routes";

interface ScenarioFile {
  name: string;
  description?: string;
  submitted_at: string;
  rates_seed?: string;
  optimizer_profile?: string;
  invoice: {
    invoice_number: string;
    exporter_id: string;
    buyer_id: string;
    currency: "SGD" | "USD";
    total_minor: string;
    line_items: { description: string; hs_code: string; quantity: number; unit_price_minor: string }[];
    invoice_date: string;
    shipment_date: string;
    purpose?: "export_of_goods" | "advance_receipt";
  };
  auto_approve_compliance_hold?: boolean;
  route_config_overrides?: {
    tokenized?: TokenizedConfigOverrides;
  };
  failure_injection?: Partial<Record<RouteId, Record<string, unknown>>>;
  expect: {
    final_state?: string;
    winning_route?: RouteId;
    recon_matched?: boolean;
    recon_break_type?: string;
  };
}

function loadFixtures() {
  const exporters = loadJsonFile<{ exporters: Exporter[] }>("data/exporters.json").exporters;
  const buyers = loadJsonFile<{ buyers: Buyer[] }>("data/buyers.json").buyers;
  const banks = loadJsonFile<{ banks: Bank[] }>("data/banks.json").banks;
  return { exporters, buyers, banks };
}

function findOrThrow<T>(list: T[], predicate: (item: T) => boolean, label: string, value: string): T {
  const found = list.find(predicate);
  if (!found) throw new Error(`${label} "${value}" not found in fixtures`);
  return found;
}

function buildInputs(scenario: ScenarioFile): WorkflowInputs {
  const { exporters, buyers, banks } = loadFixtures();
  const exporter = findOrThrow(exporters, (e) => e.exporterId === scenario.invoice.exporter_id, "Exporter", scenario.invoice.exporter_id);
  const buyer = findOrThrow(buyers, (b) => b.buyerId === scenario.invoice.buyer_id, "Buyer", scenario.invoice.buyer_id);
  const buyerBank = findOrThrow(banks, (b) => b.bankId === buyer.bankId, "Buyer bank", buyer.bankId);
  const exporterBankId = exporter.bankAccountId.split("/")[0]!;
  const exporterBank = findOrThrow(banks, (b) => b.bankId === exporterBankId, "Exporter bank", exporterBankId);

  const invoice: Invoice = {
    invoiceId: `inv_${scenario.invoice.invoice_number}`,
    invoiceNumber: scenario.invoice.invoice_number,
    exporterId: exporter.exporterId,
    buyerId: buyer.buyerId,
    currency: scenario.invoice.currency,
    totalMinor: scenario.invoice.total_minor,
    lineItems: scenario.invoice.line_items.map((li) => ({
      description: li.description,
      hsCode: li.hs_code,
      quantity: li.quantity,
      unitPriceMinor: li.unit_price_minor,
    })),
    invoiceDate: scenario.invoice.invoice_date,
    shipmentDate: scenario.invoice.shipment_date,
    purpose: scenario.invoice.purpose ?? "export_of_goods",
  };

  const routeFailureInjection: WorkflowInputs["routeFailureInjection"] = {};
  if (scenario.failure_injection) {
    for (const [routeId, injection] of Object.entries(scenario.failure_injection)) {
      routeFailureInjection[routeId as RouteId] = injection as never;
    }
  }

  return {
    invoice,
    exporter,
    buyer,
    buyerBank,
    exporterBank,
    submittedAt: scenario.submitted_at,
    ratesSeed: scenario.rates_seed ?? scenario.name,
    optimizerProfile: scenario.optimizer_profile,
    routeFailureInjection,
    tokenizedConfigOverrides: scenario.route_config_overrides?.tokenized,
    autoApproveComplianceHold: scenario.auto_approve_compliance_hold ?? false,
  };
}

function printResult(scenario: ScenarioFile, result: WorkflowRunResult): boolean {
  console.log(`\n=== ${scenario.name} ===`);
  if (scenario.description) console.log(scenario.description);
  console.log(`Final state: ${result.finalState}`);

  if (result.optimizerResult) {
    for (const r of result.optimizerResult.ranked) {
      console.log(
        `  [ranked] ${r.routeId}: score=${r.weightedScore.toFixed(4)} netINR=${toMajorUnitsString(r.metrics.netInrLanded)} timeToLanded=${r.metrics.timeToLandedMinutes}min allInCostBps=${r.metrics.allInCostBps}`,
      );
    }
    for (const g of result.optimizerResult.gated) {
      console.log(`  [gated]  ${g.routeId}: ${g.reasons.join(" | ")}`);
    }
    if (result.optimizerResult.ranked[0]) {
      console.log(`  Explanation: ${result.optimizerResult.ranked[0].explanation}`);
    }
  }

  if (result.reconResult) {
    console.log(`  Recon matched: ${result.reconResult.matched}`);
    for (const b of result.reconResult.breaks) {
      console.log(`    break: ${b.type} — ${b.detail}`);
    }
  }

  let pass = true;
  const checks: string[] = [];

  if (scenario.expect.final_state && scenario.expect.final_state !== result.finalState) {
    pass = false;
    checks.push(`expected final_state=${scenario.expect.final_state}, got ${result.finalState}`);
  }
  if (scenario.expect.winning_route && scenario.expect.winning_route !== result.chosenRouteId) {
    pass = false;
    checks.push(`expected winning_route=${scenario.expect.winning_route}, got ${result.chosenRouteId}`);
  }
  if (scenario.expect.recon_matched !== undefined && result.reconResult && scenario.expect.recon_matched !== result.reconResult.matched) {
    pass = false;
    checks.push(`expected recon_matched=${scenario.expect.recon_matched}, got ${result.reconResult.matched}`);
  }
  if (scenario.expect.recon_break_type) {
    const hasBreak = result.reconResult?.breaks.some((b) => b.type === scenario.expect.recon_break_type) ?? false;
    if (!hasBreak) {
      pass = false;
      checks.push(`expected a ${scenario.expect.recon_break_type} break, got: ${result.reconResult?.breaks.map((b) => b.type).join(", ") || "none"}`);
    }
  }

  console.log(pass ? "  RESULT: PASS" : `  RESULT: FAIL — ${checks.join("; ")}`);

  if (result.auditBundle) {
    const outDir = repoPath("out", "scenarios");
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, `${scenario.name}.json`);
    writeFileSync(outPath, JSON.stringify(toPlainJson({ scenario: scenario.name, result }), null, 2));

    const auditDir = repoPath("out", "audit");
    mkdirSync(auditDir, { recursive: true });
    // AUDIT_SEALED (always last) is emitted AFTER the bundle's chainHead is computed, so it is
    // excluded here — the bundle attests to the chain as of just before sealing.
    const chainEvents = result.events.filter((e) => e.type !== "AUDIT_SEALED");
    writeFileSync(
      join(auditDir, `${result.workflowId}.json`),
      JSON.stringify(toPlainJson({ bundle: result.auditBundle, events: chainEvents }), null, 2),
    );
    console.log(`  Scenario output: out/scenarios/${scenario.name}.json`);
    console.log(`  Audit bundle:    out/audit/${result.workflowId}.json`);
  }

  return pass;
}

async function runOne(name: string): Promise<boolean> {
  const path = repoPath("scenarios", `${name}.yaml`);
  const scenario = parseYaml(readFileSync(path, "utf-8")) as ScenarioFile;
  const inputs = buildInputs(scenario);
  const result = await runWorkflow(inputs);
  return printResult(scenario, result);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] !== "run") {
    console.error("Usage: pnpm scenario run <name> | pnpm scenario run --all");
    process.exit(2);
  }

  let names: string[];
  if (args[1] === "--all") {
    names = readdirSync(repoPath("scenarios"))
      .filter((f) => f.endsWith(".yaml"))
      .map((f) => f.replace(/\.yaml$/, ""))
      .sort();
  } else {
    const requested = args[1];
    if (!requested) {
      console.error("Usage: pnpm scenario run <name> | pnpm scenario run --all");
      process.exit(2);
    }
    names = [requested];
  }

  let allPass = true;
  for (const name of names) {
    try {
      const pass = await runOne(name);
      allPass = allPass && pass;
    } catch (err) {
      allPass = false;
      console.error(`\n=== ${name} ===`);
      console.error(`  RESULT: ERROR — ${(err as Error).message}`);
    }
  }

  console.log(`\n${names.length} scenario(s) run. ${allPass ? "ALL PASS" : "SOME FAILED"}.`);
  process.exit(allPass ? 0 : 1);
}

main();
