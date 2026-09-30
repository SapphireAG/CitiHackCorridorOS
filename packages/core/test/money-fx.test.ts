import { Decimal } from "decimal.js";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { add, applySpread, convert, CurrencyMismatchError, money, spreadBps, subtract, ValidationError } from "../src/index.js";

describe("money", () => {
  it("rejects negative amounts", () => {
    expect(() => money(-1n, "INR")).toThrow(ValidationError);
  });

  it("throws CurrencyMismatchError when adding different currencies", () => {
    expect(() => add(money(100n, "INR"), money(100n, "SGD"))).toThrow(CurrencyMismatchError);
  });

  it("throws CurrencyMismatchError when subtracting different currencies", () => {
    expect(() => subtract(money(100n, "INR"), money(100n, "SGD"))).toThrow(CurrencyMismatchError);
  });

  it("subtract never produces a negative amount silently — it throws instead", () => {
    expect(() => subtract(money(50n, "INR"), money(100n, "INR"))).toThrow(ValidationError);
  });
});

describe("fx.convert", () => {
  it("is deterministic — same inputs always produce the same output", () => {
    const source = money(1_267_000n, "SGD");
    const rate = { base: "SGD" as const, quote: "INR" as const, rate: "63.15000000" };
    const a = convert(source, rate);
    const b = convert(source, rate);
    expect(a.amountMinor).toBe(b.amountMinor);
    expect(a.currency).toBe("INR");
  });

  it("property: converting and converting back with the inverse rate recovers the original amount within a few minor units", () => {
    // Amount range matches realistic MSME invoice sizes (up to SGD 200,000.00). At larger
    // amounts, truncating the inverse rate to RATE_SCALE=8 decimal places (CLAUDE.md §5.2)
    // introduces proportionally larger absolute round-trip error — that is expected, not a bug.
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 200_000_00n }),
        fc.integer({ min: 5000, max: 200000 }), // rate * 10000 scaled, e.g. 5000 -> 0.5000, 200000 -> 20.0000
        (amountMinor, rateScaled) => {
          const rateStr = (rateScaled / 10000).toFixed(8);
          const source = money(amountMinor, "SGD");
          const forwardRate = { base: "SGD" as const, quote: "INR" as const, rate: rateStr };
          const converted = convert(source, forwardRate);

          // Use Decimal (not JS float division) for the inverse rate, so the only error in
          // this test is the two ROUND_HALF_EVEN conversion roundings themselves, not
          // floating-point imprecision in computing the inverse rate string.
          const inverseRateStr = new Decimal(1).dividedBy(new Decimal(rateStr)).toDecimalPlaces(8).toString();
          const backRate = { base: "INR" as const, quote: "SGD" as const, rate: inverseRateStr };
          const roundTripped = convert(converted, backRate);

          const diff = roundTripped.amountMinor > amountMinor ? roundTripped.amountMinor - amountMinor : amountMinor - roundTripped.amountMinor;
          expect(diff).toBeLessThanOrEqual(3n);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("property: amounts are never negative after conversion", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 1_000_000_000n }), (amountMinor) => {
        const rate = { base: "SGD" as const, quote: "INR" as const, rate: "63.15000000" };
        const result = convert(money(amountMinor, "SGD"), rate);
        expect(result.amountMinor).toBeGreaterThanOrEqual(0n);
      }),
    );
  });
});

describe("fx.spreadBps / applySpread", () => {
  it("round-trips: applying a spread then measuring it back gives (approximately) the same bps", () => {
    const mid = "63.15000000";
    const applied = applySpread(mid, 150);
    const measured = spreadBps(mid, applied);
    expect(Math.abs(measured - 150)).toBeLessThan(0.01);
  });
});
