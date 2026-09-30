/**
 * Deterministic JSON canonicalization: object keys sorted, bigint rendered as its decimal
 * string. This is the ONLY representation hashed or signed — two structurally-equal values
 * always canonicalize identically regardless of key insertion order.
 */
export function canonicalize(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const out: Record<string, unknown> = {};
  for (const [k, v] of entries) out[k] = canonicalize(v);
  return out;
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** Deep bigint->string conversion for writing human-readable JSON output files. */
export function toPlainJson(value: unknown): unknown {
  return canonicalize(value);
}
