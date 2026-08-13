import type { PartialConfig } from "./types";
import { assignValue, coerceValue, specByEnvVar } from "./schema";

/**
 * Environment variable layer (second-highest precedence). Only variables
 * with the APPD_ prefix that map to a known key are consumed; anything
 * else in the environment is ignored, never an error — the process env
 * is full of unrelated entries.
 */
export function parseEnvVars(env: Record<string, string>): PartialConfig {
  const out: PartialConfig = {};
  const names = Object.keys(env).sort(); // deterministic iteration
  for (const name of names) {
    if (!name.startsWith("APPD_")) continue;
    const spec = specByEnvVar(name);
    if (!spec) continue;
    const raw = env[name]!;
    if (raw === "") continue; // empty string means "unset"
    assignValue(out, spec, coerceValue(spec, raw, "env"));
  }
  return out;
}

/** Names of APPD_ variables that were present but not recognized. */
export function unknownEnvVars(env: Record<string, string>): string[] {
  return Object.keys(env)
    .filter((name) => name.startsWith("APPD_") && specByEnvVar(name) === undefined)
    .sort();
}
