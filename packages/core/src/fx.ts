import { Decimal } from "decimal.js";
import type { Currency, Money } from "./money.js";
import { minorUnitExponent, money } from "./money.js";
import { ValidationError } from "./errors.js";

// Fixed scale for rate decimal strings (CLAUDE.md §5.2): "63.12345678" INR per SGD.
export const RATE_SCALE = 8;

// This is the ONLY rounding point for FX conversion in the whole codebase (CLAUDE.md §5.2).
Decimal.set({ rounding: Decimal.ROUND_HALF_EVEN });

export interface FxRate {
  /** e.g. "SGD" */
  readonly base: Currency;
  /** e.g. "INR" */
  readonly quote: Currency;
  /** Decimal string, scale RATE_SCALE: units of `quote` per 1 unit of `base`. */
  readonly rate: string;
}

/**
 * Convert `source` (in `source.currency`, i.e. `rate.base`) into `rate.quote`, using
 * ROUND_HALF_EVEN at the target currency's minor-unit scale. This is the single rounding
 * point for FX in CorridorOS (CLAUDE.md §5.2) — never round anywhere else.
 */
export function convert(source: Money, rate: FxRate): Money {
  if (source.currency !== rate.base) {
    throw new ValidationError("FX rate base currency does not match source money currency", {
      sourceCurrency: source.currency,
      rateBase: rate.base,
    });
  }
  const sourceExp = minorUnitExponent(source.currency);
  const targetExp = minorUnitExponent(rate.quote);

  const sourceMinor = new Decimal(source.amountMinor.toString());
  const rateDecimal = new Decimal(rate.rate);
  const scaleAdjust = new Decimal(10).pow(targetExp - sourceExp);

  const targetMinor = sourceMinor.mul(rateDecimal).mul(scaleAdjust).toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN);

  return money(BigInt(targetMinor.toString()), rate.quote);
}

/**
 * Spread in basis points of an applied rate against the mid rate, for a sell-foreign /
 * buy-quote conversion (e.g. selling SGD to buy INR). Sign convention: POSITIVE spreadBps
 * means the applied rate is worse for the seller than mid (the bank/route keeps the
 * difference) — i.e. spreadBps = (mid - applied) / mid * 10_000. A route with a tighter
 * (smaller) spreadBps is cheaper for the exporter.
 */
export function spreadBps(midRate: string, appliedRate: string): number {
  const mid = new Decimal(midRate);
  const applied = new Decimal(appliedRate);
  if (mid.isZero()) {
    throw new ValidationError("Mid rate must not be zero when computing spread");
  }
  return mid.minus(applied).div(mid).mul(10_000).toDecimalPlaces(4).toNumber();
}

/** Apply a spread (in bps) against a mid rate to produce the applied rate, same sign convention as spreadBps. */
export function applySpread(midRate: string, bps: number): string {
  const mid = new Decimal(midRate);
  const applied = mid.mul(new Decimal(1).minus(new Decimal(bps).div(10_000)));
  return applied.toDecimalPlaces(RATE_SCALE).toString();
}
