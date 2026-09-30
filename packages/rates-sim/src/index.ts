import { Decimal } from "decimal.js";
import type { Currency, FxRate } from "@corridoros/core";
import { RATE_SCALE } from "@corridoros/core";

/**
 * Seeded, deterministic random-walk FX mid-rate simulator (CLAUDE.md §5.2). NOT a live FX feed.
 * Given the same seed and the same instant, this always returns the same rate — required for
 * reproducible scenarios and tests. Rates are illustrative placeholders only.
 */

const EPOCH = new Date("2026-01-01T00:00:00.000Z");
const DAY_MS = 86_400_000;

// Illustrative base mids, scale 8. Not sourced from any live market feed.
const BASE_MID: Record<string, string> = {
  "SGD/INR": "63.15000000",
  "USD/INR": "84.20000000",
  "SGD/USD": "0.75000000",
};

const DAILY_VOLATILITY: Record<string, number> = {
  "SGD/INR": 0.004, // +-0.4% per day step, cumulative random walk
  "USD/INR": 0.003,
  "SGD/USD": 0.003,
};

function pairKey(base: Currency, quote: Currency): string {
  return `${base}/${quote}`;
}

// FNV-1a — a small, dependency-free, deterministic string hash.
function hashToUint32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// mulberry32 — a small, dependency-free, deterministic PRNG. Not cryptographic; fine for a
// simulated market data generator.
function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function cumulativeWalkFraction(seed: string, key: string, dayIndex: number): number {
  const volatility = DAILY_VOLATILITY[key];
  if (volatility === undefined) {
    throw new Error(`No rates-sim configuration for pair ${key}`);
  }
  let cumulative = 0;
  for (let day = 0; day <= dayIndex; day++) {
    const rng = mulberry32(hashToUint32(`${seed}:${key}:${day}`));
    const step = (rng() - 0.5) * 2 * volatility; // symmetric step in [-volatility, +volatility]
    cumulative += step;
  }
  // Clamp cumulative drift so the walk never produces an economically absurd rate over a
  // short demo horizon.
  return Math.max(-0.3, Math.min(0.3, cumulative));
}

export interface RatesSimOptions {
  /** Deterministic seed — same seed + same instant always yields the same rate. */
  seed: string;
}

export class RatesSim {
  constructor(private readonly options: RatesSimOptions) {}

  /** Deterministic mid rate for base->quote at `instant`. Scale RATE_SCALE decimal string. */
  midRate(base: Currency, quote: Currency, instant: Date): FxRate {
    const key = pairKey(base, quote);
    const baseMid = BASE_MID[key];
    if (baseMid !== undefined) {
      const dayIndex = Math.max(0, Math.floor((instant.getTime() - EPOCH.getTime()) / DAY_MS));
      const drift = cumulativeWalkFraction(this.options.seed, key, dayIndex);
      const rate = new Decimal(baseMid).mul(new Decimal(1).plus(drift)).toDecimalPlaces(RATE_SCALE);
      return { base, quote, rate: rate.toString() };
    }
    // Derive an inverse pair if we only configured the forward direction.
    const inverseKey = pairKey(quote, base);
    if (BASE_MID[inverseKey] !== undefined) {
      const forward = this.midRate(quote, base, instant);
      const inverted = new Decimal(1).div(new Decimal(forward.rate)).toDecimalPlaces(RATE_SCALE);
      return { base, quote, rate: inverted.toString() };
    }
    throw new Error(`No rates-sim configuration for pair ${key}`);
  }
}
