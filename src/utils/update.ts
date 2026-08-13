/**
 * Update check — polls https://klaatai.com/api/latest (which tracks the
 * latest GitHub release, i.e. the version every install channel serves) and
 * compares against the running version.
 *
 * The endpoint also serves `minSupported`: the version floor below which this
 * CLI is no longer allowed to run (breaking protocol/auth change). Below the
 * floor the startup gate makes the update MANDATORY instead of asking —
 * see src/commands/update-gate.ts.
 *
 * Fail-silent by design: no network, bad JSON, or slow endpoint must never
 * affect the CLI. Result cached in ~/.klaatai/update-check.json so we hit
 * the endpoint at most once per CHECK_INTERVAL.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { version as VERSION } from "../../package.json";

const LATEST_URL = "https://klaatai.com/api/latest";
const CACHE_FILE = join(homedir(), ".klaatai", "update-check.json");
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4h
const FETCH_TIMEOUT_MS = 3_000;

export interface UpdateInfo {
  current: string;
  latest: string;
  updateAvailable: boolean;
  /** Version floor from the server; running below it is unsupported. */
  minSupported?: string;
  /** true ⇒ current < minSupported: update is not optional. */
  mandatory: boolean;
  /** Optional release note the server wants shown with the prompt. */
  notes?: string;
}

interface CacheShape {
  checkedAt: number;
  latest: string;
  minSupported?: string;
  notes?: string;
  /** Latest version the user answered "no" to — don't re-prompt for it. */
  dismissed?: string;
}

/** -1 if a<b, 0 if equal, 1 if a>b. Prerelease tags compared lexically after the triple. */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string): { nums: number[]; pre: string } => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?/.exec(v.trim().replace(/^v/, ""));
    if (!m) return { nums: [0, 0, 0], pre: "" };
    return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? "" };
  };
  const pa = parse(a), pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i]! !== pb.nums[i]!) return pa.nums[i]! < pb.nums[i]! ? -1 : 1;
  }
  // No prerelease > prerelease (1.0.0 > 1.0.0-beta)
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

function readCache(): CacheShape | null {
  try {
    const c = JSON.parse(readFileSync(CACHE_FILE, "utf-8")) as CacheShape;
    if (typeof c.checkedAt === "number" && typeof c.latest === "string") return c;
  } catch { /* no cache */ }
  return null;
}

function writeCache(patch: Partial<CacheShape>): void {
  try {
    mkdirSync(join(homedir(), ".klaatai"), { recursive: true });
    const prev = readCache();
    writeFileSync(CACHE_FILE, JSON.stringify({ ...(prev ?? {}), ...patch }));
  } catch { /* fail-silent */ }
}

/** Extract the first semver-looking token from arbitrary text (e.g. `--version` output). */
export function parseVersionOutput(text: string): string | null {
  const m = /(\d+\.\d+\.\d+(?:-[\w.]+)?)/.exec(text);
  return m ? m[1]! : null;
}

interface LatestPayload {
  version: string;
  minSupported?: string;
  notes?: string;
}

async function fetchLatest(): Promise<LatestPayload | null> {
  try {
    const res = await fetch(LATEST_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "User-Agent": `klaatcode/${VERSION}` },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: string; minSupported?: string; notes?: string };
    if (typeof body.version !== "string" || !body.version) return null;
    return {
      version: body.version,
      minSupported: typeof body.minSupported === "string" ? body.minSupported : undefined,
      notes: typeof body.notes === "string" && body.notes ? body.notes : undefined,
    };
  } catch {
    return null;
  }
}

/** Build UpdateInfo from a version pair — pure, so the gate logic is testable. */
export function buildUpdateInfo(
  current: string,
  latest: string,
  minSupported?: string,
  notes?: string,
): UpdateInfo {
  return {
    current,
    latest,
    updateAvailable: compareSemver(current, latest) < 0,
    minSupported,
    // A floor newer than the latest release would strand everyone — ignore it.
    mandatory: !!minSupported
      && compareSemver(current, minSupported) < 0
      && compareSemver(minSupported, latest) <= 0,
    notes,
  };
}

/**
 * Check for a newer release. Cached (4h) unless `force`.
 * Returns null when the check could not be performed (offline etc.).
 */
export async function checkForUpdate(force = false): Promise<UpdateInfo | null> {
  let payload: LatestPayload | null = null;

  if (!force) {
    const cache = readCache();
    if (cache && Date.now() - cache.checkedAt < CHECK_INTERVAL_MS) {
      payload = { version: cache.latest, minSupported: cache.minSupported, notes: cache.notes };
    }
  }
  if (!payload) {
    payload = await fetchLatest();
    if (payload) {
      writeCache({
        checkedAt: Date.now(),
        latest: payload.version,
        minSupported: payload.minSupported,
        notes: payload.notes,
      });
    }
  }
  if (!payload) return null;

  return buildUpdateInfo(VERSION, payload.version, payload.minSupported, payload.notes);
}

/** Remember that the user declined this version, so we stop asking every launch. */
export function dismissUpdate(version: string): void {
  writeCache({ dismissed: version });
}

/** Has the user already declined this exact version? */
export function isUpdateDismissed(version: string): boolean {
  return readCache()?.dismissed === version;
}

/** Clear a dismissal (e.g. after a successful upgrade). */
export function clearDismissal(): void {
  writeCache({ dismissed: undefined });
}
