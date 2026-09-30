import { loadYamlFile } from "@corridoros/core";

export interface CorrespondentHop {
  id: string;
  from: string;
  to: string;
  fixed_fee_minor: number;
  percentage_fee_bps: number;
  deducted_from_principal: boolean;
  fx_spread_bps?: number;
  processing_minutes: number;
  calendar: "in" | "sg" | "us";
  cutoff_key: string | null;
}

export interface CorrespondentPath {
  id: string;
  label: string;
  hops: CorrespondentHop[];
}

export interface CorrespondentConfig {
  illustrative: boolean;
  source: string;
  as_of: string;
  paths: CorrespondentPath[];
  liquidity_certainty: number;
  quote_validity_minutes: number;
  active_path_id: string;
  failure_injection_modes: string[];
}

let cached: CorrespondentConfig | null = null;

export function loadCorrespondentConfig(): CorrespondentConfig {
  if (!cached) cached = loadYamlFile<CorrespondentConfig>("config/routes/correspondent.yaml");
  return cached;
}

export function activePath(cfg: CorrespondentConfig): CorrespondentPath {
  const path = cfg.paths.find((p) => p.id === cfg.active_path_id);
  if (!path) throw new Error(`Unknown active_path_id "${cfg.active_path_id}" in correspondent config`);
  return path;
}
