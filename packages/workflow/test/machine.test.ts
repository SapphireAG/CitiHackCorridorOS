import { FixedClock } from "@corridoros/core";
import { describe, expect, it } from "vitest";
import { applyTransition, deriveState, TRANSITIONS } from "../src/machine.js";
import { EventStore } from "../src/eventStore.js";

describe("workflow state machine — every transition in the table", () => {
  for (const [from, targets] of Object.entries(TRANSITIONS)) {
    for (const to of targets) {
      it(`allows ${from} -> ${to}`, () => {
        expect(applyTransition(from as never, to as never)).toBe(to);
      });
    }
  }

  it("throws IllegalTransitionError on an illegal transition", () => {
    expect(() => applyTransition("DRAFT", "AUDIT_SEALED")).toThrow(/Illegal transition/);
  });

  it("AUDIT_SEALED is terminal — no transitions are allowed out of it", () => {
    expect(TRANSITIONS.AUDIT_SEALED).toEqual([]);
  });
});

describe("workflow event log — replay and idempotency", () => {
  it("replaying the event log reproduces the same state", () => {
    const clock = new FixedClock("2026-01-01T00:00:00.000Z");
    const store = new EventStore();
    store.append("wf1", "INVOICE_SUBMITTED", {}, { type: "system", id: "test" }, "k1", clock);
    store.append("wf1", "INVOICE_VERIFIED", {}, { type: "system", id: "test" }, "k2", clock);
    store.append("wf1", "COMPLIANCE_CLEARED", {}, { type: "system", id: "test" }, "k3", clock);

    const events = store.getEvents("wf1");
    expect(deriveState(events)).toBe("COMPLIANCE_CLEARED");
    // Replaying the same log from scratch reproduces the identical state.
    expect(deriveState([...events])).toBe(deriveState(events));
  });

  it("double delivery of the same idempotency key is a no-op", () => {
    const clock = new FixedClock("2026-01-01T00:00:00.000Z");
    const store = new EventStore();
    const first = store.append("wf2", "INVOICE_SUBMITTED", { n: 1 }, { type: "system", id: "test" }, "same-key", clock);
    const second = store.append("wf2", "INVOICE_SUBMITTED", { n: 2 }, { type: "system", id: "test" }, "same-key", clock);

    expect(store.getEvents("wf2")).toHaveLength(1);
    expect(second).toEqual(first);
    expect((second.payload as { n: number }).n).toBe(1); // the original event, not the replay's payload
  });

  it("appending an illegal transition throws and does not mutate the log", () => {
    const clock = new FixedClock("2026-01-01T00:00:00.000Z");
    const store = new EventStore();
    store.append("wf3", "INVOICE_SUBMITTED", {}, { type: "system", id: "test" }, "k1", clock);
    expect(() => store.append("wf3", "AUDIT_SEALED", {}, { type: "system", id: "test" }, "k2", clock)).toThrow(/Illegal transition/);
    expect(store.getEvents("wf3")).toHaveLength(1);
  });

  it("the hash chain links each event to the previous one", () => {
    const clock = new FixedClock("2026-01-01T00:00:00.000Z");
    const store = new EventStore();
    store.append("wf4", "INVOICE_SUBMITTED", {}, { type: "system", id: "test" }, "k1", clock);
    store.append("wf4", "INVOICE_VERIFIED", {}, { type: "system", id: "test" }, "k2", clock);
    const events = store.getEvents("wf4");
    expect(events[1]!.prevHash).toBe(events[0]!.hash);
    expect(events[0]!.prevHash).toBe("GENESIS");
  });
});
