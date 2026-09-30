import { computeEventHash, GENESIS_HASH } from "@corridoros/audit";
import type { Clock } from "@corridoros/core";
import type { Actor, WorkflowEvent, WorkflowState } from "@corridoros/domain";
import { applyTransition, deriveState } from "./machine.js";

/**
 * In-memory, append-only event store, event-sourced (CLAUDE.md §4). Each append is idempotent:
 * replaying the same idempotencyKey as the immediately-preceding event is a no-op that returns
 * the existing event rather than appending a duplicate.
 */
export class EventStore {
  private readonly byWorkflow = new Map<string, WorkflowEvent[]>();

  append<TPayload>(
    workflowId: string,
    type: string,
    payload: TPayload,
    actor: Actor,
    idempotencyKey: string,
    clock: Clock,
  ): WorkflowEvent<TPayload> {
    const list = this.byWorkflow.get(workflowId) ?? [];
    const last = list[list.length - 1];

    if (last && last.idempotencyKey === idempotencyKey) {
      return last as WorkflowEvent<TPayload>; // idempotent replay — no-op
    }

    const currentState = deriveState(list);
    applyTransition(currentState, type as WorkflowState); // throws IllegalTransitionError if not allowed

    const prevHash = last ? last.hash : GENESIS_HASH;
    const seq = list.length;
    const eventWithoutHash = {
      workflowId,
      seq,
      type,
      payload,
      actor,
      at: clock.now().toISOString(),
      idempotencyKey,
      prevHash,
    };
    const hash = computeEventHash(eventWithoutHash);
    const event: WorkflowEvent<TPayload> = { ...eventWithoutHash, hash };

    this.byWorkflow.set(workflowId, [...list, event as WorkflowEvent]);
    return event;
  }

  getEvents(workflowId: string): WorkflowEvent[] {
    return this.byWorkflow.get(workflowId) ?? [];
  }

  getState(workflowId: string): WorkflowState {
    return deriveState(this.getEvents(workflowId));
  }
}
