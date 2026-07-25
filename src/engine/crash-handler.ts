/**
 * Process-level crash handler for the TUI.
 *
 * On fatal errors: restore the terminal, fsync the session file, print a
 * resume hint, and exit non-zero. A boot marker under ~/.klaatai/ detects
 * crash loops during startup so the next run can skip plugins/MCP.
 */

import {
  existsSync,
  mkdirSync,
  openSync,
  fsyncSync,
  closeSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  restoreTerminal,
  disableMouse,
  disableKitty,
  disableBracketedPaste,
} from "./terminal.js";

const KLAATAI_DIR = join(homedir(), ".klaatai");
const BOOT_MARKER = join(KLAATAI_DIR, ".boot-marker");

export interface CrashHandlerOptions {
  getSessionId?: () => string | undefined;
  getSessionFile?: () => string | undefined;
  onCrash?: () => void;
}

let installed = false;
let handling = false;

/** Best-effort terminal teardown after a fatal error. */
export function restoreTerminalAfterCrash(): void {
  try {
    disableBracketedPaste();
    disableKitty();
    disableMouse();
    restoreTerminal();
  } catch {
    // Terminal may already be in a broken state — keep going.
  }
}

/** Fsync the session JSONL so the last append is durable on disk. */
export function fsyncSessionFile(path?: string): void {
  if (!path) return;
  try {
    const fd = openSync(path, "r");
    fsyncSync(fd);
    closeSync(fd);
  } catch {
    // Session file may not exist yet — ignore.
  }
}

export function formatResumeHint(sessionId: string): string {
  return `Session saved. Resume with:\n  klaatai --resume ${sessionId}\n`;
}

export function installCrashHandler(opts: CrashHandlerOptions = {}): void {
  if (installed) return;
  installed = true;

  const handle = (label: string, err: unknown) => {
    if (handling) return;
    handling = true;

    try {
      opts.onCrash?.();
    } catch {
      // onCrash must not block teardown.
    }

    restoreTerminalAfterCrash();
    fsyncSessionFile(opts.getSessionFile?.());

    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`\n\x1b[31mFatal error (${label}): ${message}\x1b[0m\n`);

    const sessionId = opts.getSessionId?.();
    if (sessionId) {
      process.stderr.write(`\x1b[2m${formatResumeHint(sessionId)}\x1b[0m`);
    }

    process.exit(1);
  };

  process.on("uncaughtException", (err) => handle("uncaughtException", err));
  process.on("unhandledRejection", (reason) => handle("unhandledRejection", reason));
}

/** Mark that a TUI boot is in progress (cleared once the REPL is ready). */
export function writeBootMarker(): void {
  mkdirSync(KLAATAI_DIR, { recursive: true });
  writeFileSync(BOOT_MARKER, new Date().toISOString(), "utf-8");
}

export function clearBootMarker(): void {
  try {
    if (existsSync(BOOT_MARKER)) unlinkSync(BOOT_MARKER);
  } catch {
    // Best effort.
  }
}

/** True when the previous run exited before clearing the boot marker. */
export function detectBootCrashLoop(): boolean {
  return existsSync(BOOT_MARKER);
}

/** Reset handler state — for tests only. */
export function _resetCrashHandlerForTests(): void {
  installed = false;
  handling = false;
}
