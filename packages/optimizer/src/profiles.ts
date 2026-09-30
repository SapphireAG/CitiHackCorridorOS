import { loadYamlFile } from "@corridoros/core";

export interface ProfileWeights {
  cost: number;
  time: number;
  liquidity: number;
  compliance: number;
}

interface OptimizerProfilesConfig {
  profiles: Record<string, ProfileWeights>;
  default_profile: string;
}

/** Config I/O lives here, separate from the pure optimize() function (CLAUDE.md §7). */
export function loadOptimizerProfile(name?: string): { name: string; weights: ProfileWeights } {
  const cfg = loadYamlFile<OptimizerProfilesConfig>("config/optimizer_profiles.yaml");
  const resolvedName = name ?? cfg.default_profile;
  const weights = cfg.profiles[resolvedName];
  if (!weights) throw new Error(`Unknown optimizer profile "${resolvedName}"`);
  return { name: resolvedName, weights };
}
