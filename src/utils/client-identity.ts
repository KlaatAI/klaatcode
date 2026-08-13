/**
 * Client identity headers — what the admin dashboard uses to answer "how many
 * CLIs are live, on which versions, from where".
 *
 * Sent on every API request:
 *   X-KlaatAI-Client-Version   2.4.2
 *   X-KlaatAI-Platform         darwin-arm64
 *   X-KlaatAI-Install-Channel  npm | brew | installer | source | unknown
 *   X-KlaatAI-Install-Id       random uuid, persisted in ~/.klaatai/install-id
 *
 * The install id is RANDOM, not derived from the machine (no hostname, no MAC
 * hash): it distinguishes installs so the server can count active clients
 * without being able to fingerprint hardware. Nothing about the project — path,
 * repo name, file names — is ever included.
 *
 * Opt out with KLAATAI_TELEMETRY=0 or `"telemetry": "off"` in
 * ~/.klaatai/config.json: the install id is then omitted and the server keeps
 * no per-install row. Version/platform still travel, because the gateway needs
 * them to enforce the minimum supported client and to route around
 * version-specific bugs.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { version as VERSION } from "../../package.json";
import { detectInstallChannel } from "../commands/upgrade.js";
import { loadConfig } from "../auth/credentials.js";

const INSTALL_ID_FILE = join(homedir(), ".klaatai", "install-id");

/** true when the user opted out of install-level telemetry. */
export function telemetryEnabled(): boolean {
  if (process.env["KLAATAI_TELEMETRY"] === "0" || process.env["DO_NOT_TRACK"] === "1") return false;
  try { return loadConfig().telemetry !== "off"; } catch { return true; }
}

/** Read (or mint) the persistent random install id. Null if it cannot be stored. */
export function loadInstallId(): string | null {
  try {
    const existing = readFileSync(INSTALL_ID_FILE, "utf-8").trim();
    if (/^[0-9a-f-]{36}$/i.test(existing)) return existing;
  } catch { /* not created yet */ }
  try {
    mkdirSync(join(homedir(), ".klaatai"), { recursive: true, mode: 0o700 });
    const id = randomUUID();
    writeFileSync(INSTALL_ID_FILE, id, { mode: 0o600 });
    return id;
  } catch {
    // Read-only home (containers, CI): stay anonymous rather than failing.
    return null;
  }
}

export interface ClientIdentity {
  version: string;
  platform: string;
  channel: string;
  installId: string | null;
}

let _cached: ClientIdentity | null = null;

/** Resolved once per process — channel detection touches the filesystem. */
export function clientIdentity(): ClientIdentity {
  if (_cached) return _cached;
  _cached = {
    version: VERSION,
    platform: `${process.platform}-${process.arch}`,
    channel: detectInstallChannel(),
    installId: telemetryEnabled() ? loadInstallId() : null,
  };
  return _cached;
}

/** Header map to merge into every outbound request. */
export function clientIdentityHeaders(): Record<string, string> {
  const id = clientIdentity();
  const h: Record<string, string> = {
    "X-KlaatAI-Client-Version": id.version,
    "X-KlaatAI-Platform": id.platform,
    "X-KlaatAI-Install-Channel": id.channel,
  };
  if (id.installId) h["X-KlaatAI-Install-Id"] = id.installId;
  return h;
}

/** Test seam — drops the memoized identity. */
export function _resetClientIdentityCache(): void {
  _cached = null;
}
