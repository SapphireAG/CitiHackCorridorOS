import { createPublicKey, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import type {
  AuditBundle,
  ComplianceDecision,
  OptimizerResult,
  Quote,
  ReconResult,
  RouteId,
  WorkflowEvent,
} from "@corridoros/domain";
import { AuditChainTamperedError } from "@corridoros/core";
import { canonicalStringify } from "./canonical.js";
import { verifyEventChain } from "./chain.js";

export interface SealBundleParams {
  workflowId: string;
  invoiceHash: string;
  complianceDecisions: ComplianceDecision[];
  allQuotes: Quote[];
  optimizerResult: OptimizerResult;
  chosenRouteId: RouteId;
  settlementRefs: string[];
  payoutRef: string | null;
  reconResult: ReconResult | null;
  events: WorkflowEvent[];
  sealedAt: string;
}

/**
 * Ed25519 signing key. This demo generates an ephemeral keypair per bundle and embeds the
 * public key in the bundle itself, so `audit:verify` works fully offline. A real deployment
 * would load a stable key from env/KMS (see .env.example AUDIT_SIGNING_KEY) instead.
 */
function ephemeralKeyPair() {
  return generateKeyPairSync("ed25519");
}

export function sealBundle(params: SealBundleParams): AuditBundle {
  const chainCheck = verifyEventChain(params.events);
  if (!chainCheck.valid) {
    throw new AuditChainTamperedError(chainCheck.brokenAtSeq ?? -1);
  }
  const chainHead = params.events.at(-1)?.hash ?? "GENESIS";

  const unsigned = {
    workflowId: params.workflowId,
    invoiceHash: params.invoiceHash,
    complianceDecisions: params.complianceDecisions,
    allQuotes: params.allQuotes,
    optimizerResult: params.optimizerResult,
    chosenRouteId: params.chosenRouteId,
    settlementRefs: params.settlementRefs,
    payoutRef: params.payoutRef,
    reconResult: params.reconResult,
    chainHead,
    sealedAt: params.sealedAt,
  };

  const { privateKey, publicKey } = ephemeralKeyPair();
  const signature = cryptoSign(null, Buffer.from(canonicalStringify(unsigned)), privateKey);
  const publicKeyHex = publicKey.export({ type: "spki", format: "der" }).toString("hex");

  return { ...unsigned, signature: signature.toString("hex"), publicKey: publicKeyHex };
}

/** Recomputes the event hash chain AND verifies the Ed25519 signature — `pnpm audit:verify`. */
export function verifyBundle(bundle: AuditBundle, events: WorkflowEvent[]): { valid: boolean; reason?: string } {
  const chainCheck = verifyEventChain(events);
  if (!chainCheck.valid) {
    return { valid: false, reason: `Event hash chain broken at seq ${chainCheck.brokenAtSeq}` };
  }
  const chainHead = events.at(-1)?.hash ?? "GENESIS";
  if (chainHead !== bundle.chainHead) {
    return { valid: false, reason: `Recomputed chain head ${chainHead} does not match bundle.chainHead ${bundle.chainHead}` };
  }

  const { signature, publicKey, ...unsigned } = bundle;
  try {
    const pubKeyObj = createPublicKey({ key: Buffer.from(publicKey, "hex"), format: "der", type: "spki" });
    const ok = cryptoVerify(null, Buffer.from(canonicalStringify(unsigned)), pubKeyObj, Buffer.from(signature, "hex"));
    return ok ? { valid: true } : { valid: false, reason: "Ed25519 signature does not match bundle contents" };
  } catch (err) {
    return { valid: false, reason: `Signature verification error: ${(err as Error).message}` };
  }
}
