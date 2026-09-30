import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";

// Resolve the repo root relative to this file (packages/core/src/config.ts -> repo root),
// so config loading works regardless of process.cwd().
const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(__dirname, "..", "..", "..");

export function repoPath(...segments: string[]): string {
  return join(REPO_ROOT, ...segments);
}

export function loadYamlFile<T = unknown>(relativePath: string): T {
  const raw = readFileSync(repoPath(relativePath), "utf-8");
  return parseYaml(raw) as T;
}

export function loadJsonFile<T = unknown>(relativePath: string): T {
  const raw = readFileSync(repoPath(relativePath), "utf-8");
  return JSON.parse(raw) as T;
}
