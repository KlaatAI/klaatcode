import type { AppConfig, PartialConfig } from "./types";

/**
 * Layer merging. Later layers win key-by-key; sections merge shallowly
 * (the config tree is exactly two levels deep by design).
 */
export function mergeTwo(base: PartialConfig, over: PartialConfig): PartialConfig {
  const out: Record<string, Record<string, unknown>> = {};
  const sections = new Set([...Object.keys(base), ...Object.keys(over)]);
  for (const section of sections) {
    const b = (base as Record<string, Record<string, unknown> | undefined>)[section] ?? {};
    const o = (over as Record<string, Record<string, unknown> | undefined>)[section] ?? {};
    out[section] = { ...b, ...o };
  }
  return out as PartialConfig;
}

/**
 * Merge an ordered list of layers, lowest precedence first. The first
 * layer is expected to be the complete defaults, so the result is total.
 */
export function mergeLayers(layers: PartialConfig[]): AppConfig {
  let acc: PartialConfig = {};
  for (const layer of layers) {
    acc = mergeTwo(acc, layer);
  }
  return acc as AppConfig;
}

/** Keys (as "section.key" paths) that a partial layer defines. */
export function definedPaths(layer: PartialConfig): string[] {
  const paths: string[] = [];
  for (const [section, body] of Object.entries(layer)) {
    for (const key of Object.keys(body as Record<string, unknown>)) {
      paths.push(`${section}.${key}`);
    }
  }
  return paths.sort();
}
