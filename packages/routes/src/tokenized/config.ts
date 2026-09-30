import { loadYamlFile } from "@corridoros/core";

export interface TokenizedConfig {
  illustrative: boolean;
  source: string;
  as_of: string;
  network: { members: { bank_id: string }[] };
  per_transaction_limit_minor: { currency: string; amount: string };
  liquidity_pool: { depth_minor: { currency: string; amount: string }; max_slippage_bps: number };
  fees: { swap_fee_bps: number; payout_fee_minor: number };
  fx_spread_bps: number;
  timing: {
    ledger_settlement_minutes: number;
    inr_payout: { processing_minutes: number; calendar: "in" | "sg" | "us"; cutoff_key: string | null };
  };
  quote_validity_minutes: number;
  failure_injection_modes: string[];
}

export interface TokenizedConfigOverrides {
  liquidity_pool?: { depth_minor?: { amount?: string }; max_slippage_bps?: number };
  per_transaction_limit_minor?: { amount?: string };
}

let cached: TokenizedConfig | null = null;

function base(): TokenizedConfig {
  if (!cached) cached = loadYamlFile<TokenizedConfig>("config/routes/tokenized.yaml");
  return cached;
}

/** Scenarios can override a handful of fields (e.g. a thin liquidity pool) without mutating config/. */
export function loadTokenizedConfig(overrides?: TokenizedConfigOverrides): TokenizedConfig {
  const cfg = base();
  if (!overrides) return cfg;
  return {
    ...cfg,
    liquidity_pool: {
      ...cfg.liquidity_pool,
      depth_minor: { ...cfg.liquidity_pool.depth_minor, amount: overrides.liquidity_pool?.depth_minor?.amount ?? cfg.liquidity_pool.depth_minor.amount },
      max_slippage_bps: overrides.liquidity_pool?.max_slippage_bps ?? cfg.liquidity_pool.max_slippage_bps,
    },
    per_transaction_limit_minor: {
      ...cfg.per_transaction_limit_minor,
      amount: overrides.per_transaction_limit_minor?.amount ?? cfg.per_transaction_limit_minor.amount,
    },
  };
}
