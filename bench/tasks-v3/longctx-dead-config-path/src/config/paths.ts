/**
 * Pure path helpers for locating config files. No filesystem access —
 * callers read the files and hand contents to the parsers.
 */

export interface PathContext {
  cwd: string;
  homeDir: string;
  /** Value of APPD_CONFIG_PATH if set. */
  explicitPath?: string;
}

/** Candidate JSON config locations, highest priority first. */
export function configFileCandidates(ctx: PathContext): string[] {
  const candidates: string[] = [];
  if (ctx.explicitPath !== undefined && ctx.explicitPath !== "") {
    candidates.push(ctx.explicitPath);
  }
  candidates.push(joinPath(ctx.cwd, "appd.json"));
  candidates.push(joinPath(ctx.homeDir, ".config", "appd", "appd.json"));
  return candidates;
}

/** Location of the deprecated 1.x ini file (for the export tool only). */
export function legacySettingsPath(ctx: PathContext): string {
  return joinPath(ctx.homeDir, ".appdrc");
}

export function joinPath(...parts: string[]): string {
  return parts
    .map((p, i) => (i === 0 ? p.replace(/\/+$/, "") : p.replace(/^\/+|\/+$/g, "")))
    .filter((p) => p.length > 0)
    .join("/");
}

export function isAbsolute(path: string): boolean {
  return path.startsWith("/");
}
