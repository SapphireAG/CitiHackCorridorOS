import { newId } from "@corridoros/core";
import { LedgerRejectError, type LedgerBackend, type SwapRequest, type SwapResult, type TokenSymbol } from "./types.js";

function accountKey(bankId: string, token: TokenSymbol): string {
  return `${token}:${bankId}`;
}

/** In-process ledger backend — accounts, issuer-only mint/burn, allow-listed holders, atomic swap. */
export class MemoryLedger implements LedgerBackend {
  private readonly balances = new Map<string, bigint>();
  private readonly allowList = new Map<TokenSymbol, Set<string>>();

  allowHolder(token: TokenSymbol, bankId: string): void {
    const set = this.allowList.get(token) ?? new Set<string>();
    set.add(bankId);
    this.allowList.set(token, set);
  }

  isAllowedHolder(token: TokenSymbol, bankId: string): boolean {
    return this.allowList.get(token)?.has(bankId) ?? false;
  }

  balanceOf(bankId: string, token: TokenSymbol): bigint {
    return this.balances.get(accountKey(bankId, token)) ?? 0n;
  }

  private credit(bankId: string, token: TokenSymbol, amountMinor: bigint): void {
    const key = accountKey(bankId, token);
    this.balances.set(key, (this.balances.get(key) ?? 0n) + amountMinor);
  }

  private debit(bankId: string, token: TokenSymbol, amountMinor: bigint): void {
    const key = accountKey(bankId, token);
    const current = this.balances.get(key) ?? 0n;
    if (current < amountMinor) {
      throw new LedgerRejectError("insufficient balance", { bankId, token, have: current.toString(), need: amountMinor.toString() });
    }
    this.balances.set(key, current - amountMinor);
  }

  mint(issuerBankId: string, token: TokenSymbol, toBankId: string, amountMinor: bigint): void {
    if (!this.isAllowedHolder(token, toBankId)) {
      throw new LedgerRejectError("mint target is not an allow-listed holder", { token, toBankId });
    }
    void issuerBankId; // issuer identity is checked by the caller's route/compliance layer in this simulation
    this.credit(toBankId, token, amountMinor);
  }

  burn(issuerBankId: string, token: TokenSymbol, fromBankId: string, amountMinor: bigint): void {
    void issuerBankId;
    this.debit(fromBankId, token, amountMinor);
  }

  atomicSwap(request: SwapRequest): SwapResult {
    const swapId = newId("swap");
    const fromOk =
      this.isAllowedHolder(request.fromToken, request.fromBank) &&
      this.balanceOf(request.fromBank, request.fromToken) >= request.fromAmountMinor;
    const toOk = this.isAllowedHolder(request.toToken, request.toBank);

    if (!fromOk || !toOk) {
      return {
        swapId,
        status: "REJECTED",
        reason: !fromOk ? "fromBank has insufficient balance or is not allow-listed" : "toBank is not allow-listed for toToken",
      };
    }

    // Both legs verified up front — apply atomically (no I/O between checks and mutation in
    // this in-process backend, so there is no interleaving window). The payer's fromToken is
    // extinguished; the receiver's toToken is issued — see SwapRequest doc comment.
    this.debit(request.fromBank, request.fromToken, request.fromAmountMinor);
    this.credit(request.toBank, request.toToken, request.toAmountMinor);

    return { swapId, status: "FILLED" };
  }
}
