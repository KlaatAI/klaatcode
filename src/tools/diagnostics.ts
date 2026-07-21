/**
 * Post-edit diagnostics feedback loop.
 *
 * After a successful edit/write, run a fast per-file check (linter/typechecker)
 * and hand the model its own errors in the same turn — so it fixes them before
 * returning instead of costing the user an extra round-trip. This is the
 * cheapest large accuracy win: mistakes are caught in-loop.
 *
 * Design guards: only runs locally-installed tools (never auto-installs),
 * hard timeout, capped output, config-gated. Never blocks or throws.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, extname, relative } from "node:path";

export interface DiagnosticsConfig {
  enabled: boolean;
  timeoutMs: number;
  /** Per-extension override, e.g. { ".ts": "tsc --noEmit" }. `{file}` = the changed file. */
  commands?: Record<string, string>;
}

let cfg: DiagnosticsConfig = { enabled: true, timeoutMs: 8_000 };

export function configureDiagnostics(opts: Partial<DiagnosticsConfig>): void {
  cfg = { ...cfg, ...opts };
}

const MAX_DIAG_LINES = 20;

/** Is a binary available in the project's node_modules/.bin? */
function hasLocalBin(projectRoot: string, bin: string): boolean {
  return existsSync(join(projectRoot, "node_modules", ".bin", bin));
}

/** Is a command available on PATH? */
function onPathDefault(cmd: string): boolean {
  try {
    const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { timeout: 2000 });
    return r.status === 0;
  } catch { return false; }
}

export interface CommandResolveDeps {
  onPath?: (cmd: string) => boolean;
  hasLocalBin?: (projectRoot: string, bin: string) => boolean;
}

/**
 * Choose a fast per-file diagnostics command for a file, or null.
 * Exported so tests can inject PATH/local-bin stubs and assert argv shape.
 */
export function resolveDiagnosticsCommand(
  absPath: string,
  projectRoot: string,
  deps: CommandResolveDeps = {},
): string[] | null {
  const onPath = deps.onPath ?? onPathDefault;
  const localBin = deps.hasLocalBin ?? hasLocalBin;
  const ext = extname(absPath).toLowerCase();

  // Explicit config override wins.
  const override = cfg.commands?.[ext];
  if (override) return ["sh", "-c", override.replace(/\{file\}/g, JSON.stringify(absPath))];

  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
    // Prefer a locally-installed linter (fast, per-file). Never npx-install.
    if (localBin(projectRoot, "eslint")) {
      return [join(projectRoot, "node_modules", ".bin", "eslint"), "--no-color", "--format", "unix", absPath];
    }
    if (localBin(projectRoot, "biome")) {
      return [join(projectRoot, "node_modules", ".bin", "biome"), "check", "--no-colors", absPath];
    }
    return null;
  }
  if (ext === ".py") {
    if (onPath("ruff")) return ["ruff", "check", "--no-cache", "--output-format", "concise", absPath];
    if (onPath("python3")) return ["python3", "-m", "py_compile", absPath]; // syntax only
    return null;
  }
  if (ext === ".go") {
    if (onPath("gofmt")) return ["gofmt", "-e", "-l", absPath]; // -e reports syntax errors
    return null;
  }
  if (ext === ".rb") {
    if (onPath("rubocop")) return ["rubocop", "--format", "emacs", "--no-color", absPath];
    return null;
  }
  if (ext === ".swift") {
    if (onPath("swiftlint")) return ["swiftlint", "lint", "--quiet", "--reporter", "xcode", absPath];
    return null;
  }
  if (ext === ".php") {
    // Static analysis / style only — no php -l fallback (syntax-only is a different semantic level).
    if (onPath("phpstan")) return ["phpstan", "analyse", "--no-progress", "--error-format=raw", absPath];
    if (onPath("pint")) return ["pint", "--test", absPath];
    return null;
  }
  if (ext === ".kt" || ext === ".kts") {
    // No --reporter flag: ktlint 1.x changed reporter CLI; default plain output is fine.
    if (onPath("ktlint")) return ["ktlint", absPath];
    return null;
  }
  if (ext === ".sh" || ext === ".bash") {
    // shellcheck does not support zsh — do not include .zsh (false positives).
    if (onPath("shellcheck")) return ["shellcheck", "-f", "gcc", absPath];
    return null;
  }
  if (ext === ".rs") {
    // cargo check is whole-crate/slow — only via explicit config override.
    return null;
  }
  return null;
}

/**
 * Run diagnostics on a just-edited file. Returns a concise error block to
 * append to the tool result, or null when clean / unavailable / disabled.
 */
export function runDiagnostics(absPath: string, projectRoot: string): string | null {
  if (!cfg.enabled) return null;
  const cmd = resolveDiagnosticsCommand(absPath, projectRoot);
  if (!cmd) return null;

  let out: string;
  try {
    const r = spawnSync(cmd[0]!, cmd.slice(1), {
      cwd: projectRoot,
      encoding: "utf-8",
      timeout: cfg.timeoutMs,
      killSignal: "SIGKILL",
    });
    if (r.error) return null;                 // tool missing / spawn failed — silent
    if ((r.status ?? 0) === 0) return null;   // clean
    out = ((r.stdout ?? "") + "\n" + (r.stderr ?? "")).trim();
  } catch {
    return null;
  }
  if (!out) return null;

  // Make paths relative and cap the output.
  const rel = relative(projectRoot, absPath);
  let lines = out.split("\n").map(l => l.replace(absPath, rel)).filter(Boolean);
  const total = lines.length;
  if (lines.length > MAX_DIAG_LINES) {
    lines = lines.slice(0, MAX_DIAG_LINES);
    lines.push(`… ${total - MAX_DIAG_LINES} more`);
  }
  return (
    `\n\n⚠ Diagnostics after this edit — fix these before continuing:\n` +
    lines.join("\n")
  );
}
