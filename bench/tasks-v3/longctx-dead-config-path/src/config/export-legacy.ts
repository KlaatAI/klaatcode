import { parseLegacySettings } from "./legacy";
import { definedPaths } from "./merge";
import type { PartialConfig } from "./types";

/**
 * The migration/export tool: the ONLY supported consumer of deprecated
 * `.appdrc` legacy settings (see README). It converts a legacy blob into
 * a modern JSON config document the user can save as appd.json.
 */

export interface LegacyExportResult {
  /** JSON text of the equivalent modern config file. */
  json: string;
  /** "section.key" paths that were migrated. */
  migratedPaths: string[];
  /** True when the legacy file had nothing mappable. */
  empty: boolean;
}

export function exportLegacySettings(legacyContents: string | null): LegacyExportResult {
  const partial: PartialConfig = parseLegacySettings(legacyContents);
  const migratedPaths = definedPaths(partial);
  return {
    json: JSON.stringify(partial, null, 2) + "\n",
    migratedPaths,
    empty: migratedPaths.length === 0,
  };
}

/** Human-readable migration report for the CLI `appd migrate` command. */
export function describeLegacyExport(result: LegacyExportResult): string {
  if (result.empty) {
    return "No migratable settings found in legacy file.";
  }
  const lines = ["Migrated settings:"];
  for (const path of result.migratedPaths) {
    lines.push(`  - ${path}`);
  }
  lines.push("", "Review the generated appd.json and delete the old .appdrc.");
  return lines.join("\n");
}
