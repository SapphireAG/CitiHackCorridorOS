/**
 * Clock abstraction. Business logic must never read the wall clock directly (CLAUDE.md §4) —
 * every function that needs "now" takes a Clock, and tests use FixedClock for determinism.
 */
export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class FixedClock implements Clock {
  private current: Date;

  constructor(initial: Date | string) {
    this.current = typeof initial === "string" ? new Date(initial) : initial;
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  /** Test helper: advance the fixed clock, e.g. to simulate time passing between steps. */
  advanceMinutes(minutes: number): void {
    this.current = new Date(this.current.getTime() + minutes * 60_000);
  }

  set(instant: Date | string): void {
    this.current = typeof instant === "string" ? new Date(instant) : instant;
  }
}
