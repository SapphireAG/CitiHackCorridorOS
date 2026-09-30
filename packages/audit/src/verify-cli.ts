#!/usr/bin/env tsx
import { readFileSync } from "node:fs";
import type { AuditBundle, WorkflowEvent } from "@corridoros/domain";
import { verifyBundle } from "./bundle.js";

function main(): void {
  const path = process.argv[2];
  if (!path) {
    console.error("Usage: pnpm audit:verify <bundle.json>");
    process.exit(2);
  }
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw) as { bundle: AuditBundle; events: WorkflowEvent[] };

  const result = verifyBundle(parsed.bundle, parsed.events);
  if (result.valid) {
    console.log(`VALID — audit bundle for workflow ${parsed.bundle.workflowId} verifies offline.`);
    console.log(`  chain head: ${parsed.bundle.chainHead}`);
    console.log(`  sealed at:  ${parsed.bundle.sealedAt}`);
    process.exit(0);
  } else {
    console.error(`INVALID — ${result.reason}`);
    process.exit(1);
  }
}

main();
