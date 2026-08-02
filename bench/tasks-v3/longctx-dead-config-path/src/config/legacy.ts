import type { PartialConfig } from "./types";
import { ConfigError } from "./types";
import { assignValue, coerceValue, specByLegacyKey } from "./schema";

/**
 * Parser for the DEPRECATED `.appdrc` ini format used by appd 1.x:
 *
 *   # comment
 *   server_port = 9999
 *   log_level = warn
 *   enable_metrics = true
 *
 * Per README, this source exists ONLY for the migration/export tool
 * (src/config/export-legacy.ts). It must never influence loadConfig()
 * resolution.
 */
export function parseLegacySettings(contents: string | null | undefined): PartialConfig {
  if (contents === null || contents === undefined || contents.trim() === "") {
    return {};
  }
  const out: PartialConfig = {};
  const lines = contents.split(/\r?\n/);
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo]!.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) {
      throw new ConfigError("legacy", `line ${lineNo + 1}: expected key = value`);
    }
    const key = line.slice(0, eq).trim();
    const raw = line.slice(eq + 1).trim();
    const spec = specByLegacyKey(key);
    if (!spec) {
      // 1.x had keys with no modern equivalent; skip them silently so
      // old files still export cleanly.
      continue;
    }
    assignValue(out, spec, coerceValue(spec, raw, "legacy"));
  }
  return out;
}

/** Whether a legacy blob contains any key that maps to the modern schema. */
export function legacyHasMappableKeys(contents: string | null | undefined): boolean {
  const parsed = parseLegacySettings(contents);
  return Object.keys(parsed).length > 0;
}
