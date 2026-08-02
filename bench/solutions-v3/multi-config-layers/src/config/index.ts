// Public entry point for configuration loading, composed from three layers:
// defaults < file < env, deep-merged per nested section.
import { AppConfig, LoadOptions } from "./types";
import { DEFAULTS } from "./defaults";
import { applyFileLayer } from "./fileLayer";
import { applyEnvLayer } from "./envLayer";

export { ConfigError } from "./types";
export type { AppConfig, LoadOptions } from "./types";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base: Record<string, unknown>, layer: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(layer)) {
    const existing = out[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      out[key] = deepMerge(existing, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function loadConfig(options: LoadOptions = {}): AppConfig {
  let merged: Record<string, unknown> = clone(DEFAULTS) as unknown as Record<string, unknown>;
  if (options.fileData !== undefined) {
    merged = deepMerge(merged, applyFileLayer(options.fileData));
  }
  if (options.env !== undefined) {
    merged = deepMerge(merged, applyEnvLayer(options.env));
  }
  return merged as unknown as AppConfig;
}
