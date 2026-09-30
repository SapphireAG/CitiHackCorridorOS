import { CurrencyMismatchError, UnknownCurrencyError, ValidationError } from "./errors.js";
import { loadYamlFile } from "./config.js";

export type Currency = "INR" | "SGD" | "USD";

export interface Money {
  readonly amountMinor: bigint;
  readonly currency: Currency;
}

interface CurrenciesConfig {
  currencies: Record<string, { name: string; minor_unit_exponent: number }>;
}

let cachedConfig: CurrenciesConfig | null = null;

function config(): CurrenciesConfig {
  if (!cachedConfig) {
    cachedConfig = loadYamlFile<CurrenciesConfig>("config/currencies.yaml");
  }
  return cachedConfig;
}

/** Minor-unit exponent for a currency, read from config/currencies.yaml. Never assume 2. */
export function minorUnitExponent(currency: string): number {
  const entry = config().currencies[currency];
  if (!entry) throw new UnknownCurrencyError(currency);
  return entry.minor_unit_exponent;
}

export function isKnownCurrency(currency: string): currency is Currency {
  return currency in config().currencies;
}

export function money(amountMinor: bigint, currency: Currency): Money {
  if (!isKnownCurrency(currency)) throw new UnknownCurrencyError(currency);
  if (amountMinor < 0n) {
    throw new ValidationError("Money amounts must not be negative", { amountMinor: amountMinor.toString(), currency });
  }
  return { amountMinor, currency };
}

/** Parse an API-shaped minor-unit string (CLAUDE.md §5.1) into Money. */
export function moneyFromString(amountMinor: string, currency: Currency): Money {
  return money(BigInt(amountMinor), currency);
}

export function moneyToString(m: Money): string {
  return m.amountMinor.toString();
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  const result = a.amountMinor - b.amountMinor;
  if (result < 0n) {
    throw new ValidationError("Subtraction would produce a negative Money amount", {
      a: moneyToString(a),
      b: moneyToString(b),
    });
  }
  return money(result, a.currency);
}

export function isZero(m: Money): boolean {
  return m.amountMinor === 0n;
}

/** -1 if a<b, 0 if equal, 1 if a>b. Throws on currency mismatch. */
export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.amountMinor < b.amountMinor) return -1;
  if (a.amountMinor > b.amountMinor) return 1;
  return 0;
}

export function max(a: Money, b: Money): Money {
  return compare(a, b) >= 0 ? a : b;
}

export function min(a: Money, b: Money): Money {
  return compare(a, b) <= 0 ? a : b;
}

/** Human-readable major-unit string, e.g. money(80000000n, "INR") -> "8,00,000.00" is NOT done
 * here (locale grouping is a display concern for the UI layer) — this returns a plain "800000.00". */
export function toMajorUnitsString(m: Money): string {
  const exp = minorUnitExponent(m.currency);
  const divisor = 10n ** BigInt(exp);
  const whole = m.amountMinor / divisor;
  const frac = m.amountMinor % divisor;
  return `${whole.toString()}.${frac.toString().padStart(exp, "0")}`;
}
