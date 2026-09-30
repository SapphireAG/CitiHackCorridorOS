import { ValidationError } from "@corridoros/core";

/**
 * Bank-issued tokenized deposits only — CLAUDE.md §2.1 / §8. Never a public stablecoin or
 * crypto asset: mint/burn is issuer-controlled, holders are allow-listed, and every unit is a
 * claim on a real bank deposit that ultimately redeems into a real bank-account credit.
 */
export type TokenSymbol = "tSGD" | "tINR";

export interface LedgerAccount {
  readonly bankId: string;
  readonly token: TokenSymbol;
  readonly balanceMinor: bigint;
}

export interface SwapRequest {
  /** The paying side: this bank's `fromToken` balance is debited (extinguished). */
  readonly fromBank: string;
  readonly fromToken: TokenSymbol;
  readonly fromAmountMinor: bigint;
  /** The receiving side: this bank's `toToken` balance is credited (issued), atomically with the debit. */
  readonly toBank: string;
  readonly toToken: TokenSymbol;
  readonly toAmountMinor: bigint;
}

export interface SwapResult {
  readonly swapId: string;
  readonly status: "FILLED" | "REJECTED";
  readonly reason?: string;
}

export class LedgerRejectError extends ValidationError {
  constructor(reason: string, context: Record<string, unknown> = {}) {
    super(`Ledger rejected operation: ${reason}`, context);
  }
}

/**
 * Backend-agnostic interface for the tokenized route (CLAUDE.md §8). The memory backend is the
 * default used by all tests and scenarios; an optional Sui backend could implement the same
 * interface without the rest of the system knowing which one is running.
 */
export interface LedgerBackend {
  /** Register a bank as an allow-listed holder of a token. Idempotent. */
  allowHolder(token: TokenSymbol, bankId: string): void;
  isAllowedHolder(token: TokenSymbol, bankId: string): boolean;

  /** Issuer-only mint, to an allow-listed holder. Throws LedgerRejectError otherwise. */
  mint(issuerBankId: string, token: TokenSymbol, toBankId: string, amountMinor: bigint): void;

  /** Issuer-only burn, from an allow-listed holder with sufficient balance. */
  burn(issuerBankId: string, token: TokenSymbol, fromBankId: string, amountMinor: bigint): void;

  balanceOf(bankId: string, token: TokenSymbol): bigint;

  /**
   * Atomic cross-currency payment-versus-payment settlement: the payer's `fromToken` is
   * extinguished and the receiver's `toToken` is issued in the same atomic step — both happen,
   * or neither does. Models one side of a corridor's value being extinguished (buyer's tSGD)
   * while the other side is created (AD bank's tINR), which the AD bank then redeems into a
   * real INR credit. Rejects (without mutating any balance) if the payer lacks sufficient
   * allow-listed balance, or either bank is not allow-listed for its token.
   */
  atomicSwap(request: SwapRequest): SwapResult;
}
