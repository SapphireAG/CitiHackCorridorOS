import { describe, expect, it } from "vitest";
import { advanceThroughHop, hopStartInstant, isBusinessDay, loadCalendar } from "../src/index.js";

describe("calendar — fixed-instant tests", () => {
  it("Republic Day (2026-01-26) is not a business day in IN", () => {
    const cal = loadCalendar("in");
    // 2026-01-26 12:00 IST -> UTC 06:30
    expect(isBusinessDay(new Date("2026-01-26T06:30:00.000Z"), cal)).toBe(false);
  });

  it("an ordinary Tuesday is a business day in IN", () => {
    const cal = loadCalendar("in");
    expect(isBusinessDay(new Date("2026-01-06T06:30:00.000Z"), cal)).toBe(true);
  });

  it("Saturday is a weekend in SG", () => {
    const cal = loadCalendar("sg");
    // 2026-01-03 is a Saturday
    expect(isBusinessDay(new Date("2026-01-03T04:00:00.000Z"), cal)).toBe(false);
  });

  it("a hop starting before its cut-off on a business day begins immediately", () => {
    const cal = loadCalendar("in");
    // Tuesday 2026-01-06, 10:00 IST = 04:30 UTC — well before the 17:00 IST cutoff
    const start = new Date("2026-01-06T04:30:00.000Z");
    const begin = hopStartInstant(start, cal, "inr_credit_processing");
    expect(begin.getTime()).toBe(start.getTime());
  });

  it("a hop starting after its cut-off rolls to the next business day", () => {
    const cal = loadCalendar("in");
    // Tuesday 2026-01-06, 19:00 IST = 13:30 UTC — after the 17:00 IST cutoff
    const start = new Date("2026-01-06T13:30:00.000Z");
    const begin = hopStartInstant(start, cal, "inr_credit_processing");
    // Should roll to Wednesday 2026-01-07 00:00 IST = 2026-01-06T18:30:00.000Z
    expect(begin.toISOString()).toBe("2026-01-06T18:30:00.000Z");
  });

  it("a hop submitted Friday evening (past cutoff) rolls over the weekend to Monday", () => {
    const cal = loadCalendar("sg");
    // Friday 2026-01-02, 21:30 SGT = 13:30 UTC — after the 19:00 SGT cutoff
    const start = new Date("2026-01-02T13:30:00.000Z");
    const begin = hopStartInstant(start, cal, "outward_payment_initiation");
    // Should roll to Monday 2026-01-05 00:00 SGT = 2026-01-04T16:00:00.000Z (a Sunday in UTC,
    // since SGT is 8 hours ahead — the instant is still Monday local time in Singapore).
    expect(begin.toISOString()).toBe("2026-01-04T16:00:00.000Z");
    expect(isBusinessDay(begin, cal)).toBe(true);
  });

  it("advanceThroughHop adds processing minutes after any cutoff/weekend roll", () => {
    const cal = loadCalendar("in");
    const start = new Date("2026-01-06T04:30:00.000Z"); // before cutoff
    const end = advanceThroughHop(start, cal, "inr_credit_processing", 240);
    expect(end.getTime() - start.getTime()).toBe(240 * 60_000);
  });
});
