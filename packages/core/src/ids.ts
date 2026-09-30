import { randomUUID } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function workflowId(): string {
  return newId("wf");
}

export function idempotencyKey(workflowIdValue: string, step: string, salt = ""): string {
  return `idem_${workflowIdValue}_${step}${salt ? `_${salt}` : ""}`;
}
