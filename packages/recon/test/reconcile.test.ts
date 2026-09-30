import { describe, expect, it } from "vitest";
import type { Invoice } from "@corridoros/domain";
import { reconcile } from "../src/reconcile.js";

const invoice: Invoice = {
  invoiceId: "inv_1",
  invoiceNumber: "INV-1",
  exporterId: "exp-0001",
  buyerId: "buy-0001",
  currency: "SGD",
  totalMinor: "1267000",
  lineItems: [{ description: "test", hsCode: "9403.60", quantity: 1, unitPriceMinor: "1267000" }],
  invoiceDate: "2026-01-01",
  shipmentDate: "2026-01-02",
  purpose: "export_of_goods",
};

const expected = { amountMinor: 80_000_000n, currency: "INR" as const };

describe("reconcile — one test per break type", () => {
  it("matches when actual equals expected, and issues simulated e-BRC/FIRA-like records", () => {
    const result = reconcile({ invoice, expected, actual: expected, landedAt: "2026-01-05T00:00:00.000Z" });
    expect(result.matched).toBe(true);
    expect(result.breaks).toHaveLength(0);
    expect(result.eBrcLike?.label).toMatch(/SIMULATED/);
    expect(result.firaLike?.label).toMatch(/SIMULATED/);
  });

  it("flags SHORT_PAYMENT when actual < expected", () => {
    const actual = { amountMinor: 75_000_000n, currency: "INR" as const };
    const result = reconcile({ invoice, expected, actual, deductingHopId: "correspondent_lift", landedAt: "2026-01-05T00:00:00.000Z" });
    expect(result.matched).toBe(false);
    expect(result.breaks[0]!.type).toBe("SHORT_PAYMENT");
    expect(result.breaks[0]!.deductingHopId).toBe("correspondent_lift");
  });

  it("flags OVERPAYMENT when actual > expected", () => {
    const actual = { amountMinor: 85_000_000n, currency: "INR" as const };
    const result = reconcile({ invoice, expected, actual, landedAt: "2026-01-05T00:00:00.000Z" });
    expect(result.breaks[0]!.type).toBe("OVERPAYMENT");
  });

  it("flags MISSING_CREDIT when actual is zero", () => {
    const actual = { amountMinor: 0n, currency: "INR" as const };
    const result = reconcile({ invoice, expected, actual, landedAt: "2026-01-05T00:00:00.000Z" });
    expect(result.breaks[0]!.type).toBe("MISSING_CREDIT");
  });

  it("flags WRONG_REFERENCE when the credit reference doesn't match the invoice reference", () => {
    const result = reconcile({
      invoice,
      expected,
      actual: expected,
      landedAt: "2026-01-05T00:00:00.000Z",
      reference: "INV-OTHER",
      invoiceReference: "INV-1",
    });
    expect(result.breaks.some((b) => b.type === "WRONG_REFERENCE")).toBe(true);
  });
});
