import { describe, expect, it } from "vitest";
import { MemoryLedger } from "../src/memory.js";

describe("MemoryLedger", () => {
  it("rejects mint to a bank that is not allow-listed", () => {
    const ledger = new MemoryLedger();
    expect(() => ledger.mint("issuer", "tSGD", "not-allowed-bank", 100n)).toThrow(/allow-listed/);
  });

  it("mint/burn round-trips a balance", () => {
    const ledger = new MemoryLedger();
    ledger.allowHolder("tSGD", "bank-a");
    ledger.mint("issuer", "tSGD", "bank-a", 1000n);
    expect(ledger.balanceOf("bank-a", "tSGD")).toBe(1000n);
    ledger.burn("issuer", "tSGD", "bank-a", 400n);
    expect(ledger.balanceOf("bank-a", "tSGD")).toBe(600n);
  });

  it("atomicSwap rejects without mutating any balance when the payer lacks funds", () => {
    const ledger = new MemoryLedger();
    ledger.allowHolder("tSGD", "buyer");
    ledger.allowHolder("tINR", "exporter");
    const result = ledger.atomicSwap({
      fromBank: "buyer",
      fromToken: "tSGD",
      fromAmountMinor: 1000n,
      toBank: "exporter",
      toToken: "tINR",
      toAmountMinor: 63000n,
    });
    expect(result.status).toBe("REJECTED");
    expect(ledger.balanceOf("buyer", "tSGD")).toBe(0n);
    expect(ledger.balanceOf("exporter", "tINR")).toBe(0n);
  });

  it("atomicSwap extinguishes the payer's token and issues the receiver's token atomically", () => {
    const ledger = new MemoryLedger();
    ledger.allowHolder("tSGD", "buyer");
    ledger.allowHolder("tINR", "exporter");
    ledger.mint("buyer", "tSGD", "buyer", 1000n);

    const result = ledger.atomicSwap({
      fromBank: "buyer",
      fromToken: "tSGD",
      fromAmountMinor: 1000n,
      toBank: "exporter",
      toToken: "tINR",
      toAmountMinor: 63000n,
    });

    expect(result.status).toBe("FILLED");
    expect(ledger.balanceOf("buyer", "tSGD")).toBe(0n);
    expect(ledger.balanceOf("exporter", "tINR")).toBe(63000n);
  });
});
