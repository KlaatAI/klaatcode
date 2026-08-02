/**
 * Proof-of-work verification — detect and run a project's test + typecheck
 * commands so the agent can PROVE an edit works instead of just claiming it.
 *
 * Detection is best-effort and framework-agnostic; the runner is a thin async
 * exec wrapper. Both are pure of REPL state so they can be unit-tested and
 * reused by `/test`, `/verify`, and the post-edit auto-hook.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { exec } from "node:child_process";

export interface DetectedCommand { cmd: string; runner: string }
export interface VerifyCommands { test: DetectedCommand | null; typecheck: DetectedCommand | null }

/** True when package.json has a non-placeholder script of the given name. */
function pkgScript(projectRoot: string, name: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf-8")) as {
      scripts?: Record<string, string>;
    };
    const s = pkg.scripts?.[name] ?? "";
    return s && !s.startsWith("echo") ? s : null;
  } catch {
    return null;
  }
}

/** Detect the project's test + typecheck commands. Either may be null. */
export function detectVerifyCommands(projectRoot: string): VerifyCommands {
  const has = (f: string) => existsSync(join(projectRoot, f));
  const isBun = has("bun.lockb") || has("bun.lock");
  const pm = isBun ? "bun" : "npm";

  // ── Test command ──────────────────────────────────────────────────────────
  let test: DetectedCommand | null = null;
  if (isBun && has("package.json")) test = { cmd: "bun test", runner: "Bun" };
  else if (has("vitest.config.ts") || has("vitest.config.js")) test = { cmd: "npx vitest run", runner: "Vitest" };
  else if (has("jest.config.js") || has("jest.config.ts")) test = { cmd: "npx jest --no-coverage", runner: "Jest" };
  else if (has("pytest.ini") || has("pyproject.toml")) test = { cmd: "python -m pytest -q", runner: "pytest" };
  else if (has("go.mod")) test = { cmd: "go test ./...", runner: "Go" };
  else if (has("Cargo.toml")) test = { cmd: "cargo test", runner: "Cargo" };
  else if (has("package.json") && pkgScript(projectRoot, "test")) test = { cmd: `${pm} test`, runner: pm };

  // ── Typecheck command (TS/Rust — the fast "did I break compilation" check) ──
  let typecheck: DetectedCommand | null = null;
  if (has("package.json") && pkgScript(projectRoot, "typecheck")) {
    typecheck = { cmd: `${pm} run typecheck`, runner: "typecheck" };
  } else if (has("tsconfig.json")) {
    typecheck = { cmd: isBun ? "bunx tsc --noEmit" : "npx tsc --noEmit", runner: "tsc" };
  } else if (has("Cargo.toml")) {
    typecheck = { cmd: "cargo check", runner: "cargo check" };
  }

  return { test, typecheck };
}

export interface CheckResult { runner: string; ok: boolean; code: number; output: string }

/** Run one command, capturing combined output (capped). Never throws. */
export function runCheck(cmd: string, runner: string, projectRoot: string, timeoutMs = 180_000): Promise<CheckResult> {
  return new Promise((resolve) => {
    exec(cmd, { cwd: projectRoot, env: process.env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const output = [stdout, stderr].filter(Boolean).join("\n").trim();
      const code = (err as (NodeJS.ErrnoException & { code?: number }) | null)?.code ?? (err ? 1 : 0);
      resolve({ runner, ok: code === 0, code: typeof code === "number" ? code : 1, output });
    });
  });
}

/** Short, model-and-human-friendly summary line for a set of check results. */
export function summarizeChecks(results: CheckResult[]): { line: string; allOk: boolean } {
  const allOk = results.every(r => r.ok);
  const parts = results.map(r => `${r.ok ? "✓" : "✗"} ${r.runner}${r.ok ? "" : ` (exit ${r.code})`}`);
  return { line: parts.join(" · "), allOk };
}

/**
 * Pull the set of source files that appear in failing check output. File-level
 * (not line-level) on purpose: an edit shifts line numbers, so line signatures
 * are fragile, but the failing FILE is stable. Used to tell "your change broke
 * this" (a failing file the turn touched) from "already broken" (untouched).
 * Paths are normalized to forward slashes; leading "./" stripped.
 */
export function extractFailingFiles(results: CheckResult[]): Set<string> {
  const files = new Set<string>();
  const patterns = [
    /([\w./\\-]+\.[a-zA-Z]+)\((\d+),(\d+)\):\s*error/,   // tsc: path(l,c): error
    /^(?:FAILED|ERROR)\s+([\w./\\-]+\.[a-zA-Z]+)/,        // pytest: FAILED path::test
    /^([\w./\\-]+\.[a-zA-Z]+):(\d+):/,                    // eslint/go/generic path:line:
    /--- FAIL.*\n\s*([\w./\\-]+\.[a-zA-Z]+):/,            // go test
    /error\[E\d+\][^\n]*\n\s*-->\s*([\w./\\-]+\.[a-zA-Z]+):/, // rust: --> path:line
  ];
  for (const r of results) {
    if (r.ok) continue;
    for (const line of r.output.split("\n")) {
      for (const re of patterns) {
        const m = re.exec(line);
        if (m?.[1]) files.add(m[1].replace(/\\/g, "/").replace(/^\.\//, ""));
      }
    }
  }
  return files;
}
