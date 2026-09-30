import { createHash } from "node:crypto";
import type { WorkflowEvent } from "@corridoros/domain";
import { canonicalStringify } from "./canonical.js";

export const GENESIS_HASH = "GENESIS";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** hash = sha256(prevHash || canonical_json(event)) — CLAUDE.md §10.2. */
export function computeEventHash(event: Omit<WorkflowEvent, "hash">): string {
  return sha256Hex(event.prevHash + canonicalStringify(event));
}

export interface ChainVerification {
  valid: boolean;
  brokenAtSeq?: number;
}

/** Recomputes every hash in sequence and checks it matches what's stored — tamper detection. */
export function verifyEventChain(events: WorkflowEvent[]): ChainVerification {
  let expectedPrevHash = GENESIS_HASH;
  for (const event of events) {
    if (event.prevHash !== expectedPrevHash) return { valid: false, brokenAtSeq: event.seq };
    const { hash, ...rest } = event;
    const recomputed = computeEventHash(rest);
    if (recomputed !== hash) return { valid: false, brokenAtSeq: event.seq };
    expectedPrevHash = hash;
  }
  return { valid: true };
}
