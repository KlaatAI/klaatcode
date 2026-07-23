/**
 * Cross-platform clipboard write.
 *
 * Returns true only when the platform clipboard tool exits successfully —
 * missing binaries / non-zero status must not be reported as success.
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";

export type SpawnSyncFn = (
  command: string,
  args: string[],
  options: { input: string; encoding: "utf-8"; shell?: boolean },
) => SpawnSyncReturns<string>;

function ok(r: SpawnSyncReturns<string>): boolean {
  return !r.error && (r.status ?? 1) === 0;
}

/**
 * Write `text` to the system clipboard.
 * @param spawn injectable for unit tests (defaults to `spawnSync`)
 */
export function copyToClipboard(
  text: string,
  spawn: SpawnSyncFn = spawnSync as SpawnSyncFn,
): boolean {
  try {
    if (process.platform === "darwin") {
      return ok(spawn("pbcopy", [], { input: text, encoding: "utf-8" }));
    }
    if (process.platform === "win32") {
      return ok(spawn("clip", [], { input: text, encoding: "utf-8", shell: true }));
    }
    // Linux / BSD — try xclip, then xsel
    const xclip = spawn("xclip", ["-selection", "clipboard"], { input: text, encoding: "utf-8" });
    if (ok(xclip)) return true;
    const xsel = spawn("xsel", ["--clipboard", "--input"], { input: text, encoding: "utf-8" });
    return ok(xsel);
  } catch {
    return false;
  }
}
