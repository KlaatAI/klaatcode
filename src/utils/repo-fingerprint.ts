/**
 * Repo fingerprint — the backbone of the per-project profile vector.
 *
 * Free, deterministic, and far more reliable than anything an LLM could extract from
 * a conversation: "this is an 84k-LOC pnpm monorepo on Next 15 with vitest and CI"
 * is a stronger prior about how a user works than any number of remembered facts.
 *
 * PROJECT ID: deliberately reuses resolveProjectId() rather than deriving its own.
 * That formula is already frozen across CLI, Desktop and VS Code and is what the code
 * graph and the X-KlaatAI-Project header key on. A second derivation would give the
 * same repository two identities, and telemetry could never be joined to the graph —
 * silently, and only discoverable much later.
 *
 * PRIVACY: no paths, no repo name, no remote URL, no file names. The branch name is
 * HASHED, not sent: branch names routinely carry ticket ids and feature descriptions.
 * Everything here is a count, a boolean, or a value from a closed vocabulary.
 *
 * COST: bounded. One `git ls-files`, one `git status --porcelain`, one package.json
 * read, and at most SAMPLE_FILES stat calls. Computed once per process.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveProjectId } from "./project-id.js";

/** Enough to extrapolate size without walking a large repo. */
const SAMPLE_FILES = 150;
/** Rough bytes-per-line across source code; loc_estimate is explicitly an estimate. */
const BYTES_PER_LINE = 38;

const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", go: "go", rs: "rust", java: "java", kt: "kotlin",
  swift: "swift", rb: "ruby", php: "php", cs: "csharp", sql: "sql",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp",
  vue: "vue", svelte: "svelte", scala: "scala", dart: "dart", ex: "elixir",
  sh: "shell", bash: "shell", lua: "lua",
};

/** Closed vocabulary — package name to reported framework. */
const FRAMEWORK_DEPS: Array<[string, string]> = [
  ["next", "next"], ["react", "react"], ["vue", "vue"], ["svelte", "svelte"],
  ["@angular/core", "angular"], ["nuxt", "nuxt"], ["astro", "astro"],
  ["express", "express"], ["fastify", "fastify"], ["nestjs", "nest"],
  ["@nestjs/core", "nest"], ["electron", "electron"], ["react-native", "react-native"],
  ["tailwindcss", "tailwind"], ["prisma", "prisma"], ["drizzle-orm", "drizzle"],
];

const TEST_RUNNER_DEPS = ["vitest", "jest", "mocha", "ava", "playwright", "cypress", "bun:test"];

export interface RepoFingerprint {
  languages: string[];
  frameworks: string[];
  package_manager: string | null;
  test_runner: string | null;
  has_ci: boolean;
  monorepo: boolean;
  file_count: number;
  loc_estimate: number;
  git_branch_hash: string | null;
  dirty_working_tree: boolean;
}

function git(cwd: string, args: string[]): string | null {
  try {
    const r = spawnSync("git", args, {
      cwd, encoding: "utf-8", timeout: 5_000, maxBuffer: 32 * 1024 * 1024,
    });
    return r.status === 0 ? r.stdout : null;
  } catch { return null; }
}

function detectPackageManager(root: string, files: Set<string>): string | null {
  if (files.has("bun.lock") || files.has("bun.lockb")) return "bun";
  if (files.has("pnpm-lock.yaml")) return "pnpm";
  if (files.has("yarn.lock")) return "yarn";
  if (files.has("package-lock.json")) return "npm";
  if (files.has("poetry.lock")) return "poetry";
  if (files.has("uv.lock")) return "uv";
  if (files.has("requirements.txt")) return "pip";
  if (files.has("Cargo.lock")) return "cargo";
  if (files.has("go.sum")) return "go";
  try { statSync(join(root, "package.json")); return "npm"; } catch { return null; }
}

let _cached: RepoFingerprint | null = null;

export function repoFingerprint(root: string): RepoFingerprint | null {
  if (_cached) return _cached;
  try {
    const listing = git(root, ["ls-files"]);
    if (listing === null) return null; // not a git repo — no fingerprint

    const paths = listing.split("\n").filter(Boolean);
    const topLevel = new Set(paths.filter((p) => !p.includes("/")));

    // Language histogram straight off the file list — no extra I/O.
    const langCounts = new Map<string, number>();
    for (const p of paths) {
      const ext = p.slice(p.lastIndexOf(".") + 1).toLowerCase();
      const lang = LANG_BY_EXT[ext];
      if (lang) langCounts.set(lang, (langCounts.get(lang) ?? 0) + 1);
    }
    const languages = [...langCounts.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 6).map(([l]) => l);

    // Frameworks and test runner from package.json only — a dependency name is a
    // closed-vocabulary lookup, never free text.
    const frameworks: string[] = [];
    let testRunner: string | null = null;
    let workspaces = false;
    try {
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        workspaces?: unknown;
      };
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      for (const [dep, label] of FRAMEWORK_DEPS) {
        if (deps[dep] && !frameworks.includes(label)) frameworks.push(label);
      }
      testRunner = TEST_RUNNER_DEPS.find((t) => deps[t]) ?? null;
      workspaces = Boolean(pkg.workspaces);
    } catch { /* no package.json, or unreadable */ }

    // Dependency sniffing misses every runner that ships with its toolchain --
    // `bun test`, `go test`, `cargo test` need no package entry. Without this fallback
    // a repo with 36 test files reports test_runner: null, which is worse than no
    // signal: it tells the router the user does not test.
    if (!testRunner) {
      const pm = detectPackageManager(root, topLevel);
      if (paths.some((p) => p.endsWith("_test.go"))) testRunner = "go-test";
      else if (topLevel.has("pytest.ini") || topLevel.has("tox.ini")
               || paths.some((p) => /(^|\/)(test_[^/]+\.py|[^/]+_test\.py)$/.test(p))) {
        testRunner = "pytest";
      } else if (paths.some((p) => /\.(test|spec)\.(ts|tsx|js|jsx|mts|cts)$/.test(p))) {
        // A JS/TS test file with no runner dependency means the toolchain's built-in.
        testRunner = pm === "bun" ? "bun:test" : "node:test";
      } else if (topLevel.has("Cargo.toml")
                 && paths.some((p) => p.startsWith("tests/") && p.endsWith(".rs"))) {
        testRunner = "cargo-test";
      }
    }

    // Size: exact file count, sampled byte total extrapolated to lines.
    const step = Math.max(1, Math.floor(paths.length / SAMPLE_FILES));
    let sampledBytes = 0;
    let sampled = 0;
    for (let i = 0; i < paths.length; i += step) {
      try {
        sampledBytes += statSync(join(root, paths[i]!)).size;
        sampled++;
      } catch { /* deleted since ls-files, or unreadable */ }
    }
    const avgBytes = sampled > 0 ? sampledBytes / sampled : 0;
    const locEstimate = Math.round((avgBytes * paths.length) / BYTES_PER_LINE);

    const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"])?.trim() || null;
    const status = git(root, ["status", "--porcelain"]);

    _cached = {
      languages,
      frameworks,
      package_manager: detectPackageManager(root, topLevel),
      test_runner: testRunner,
      has_ci: paths.some((p) => p.startsWith(".github/workflows/"))
        || topLevel.has(".gitlab-ci.yml") || topLevel.has("azure-pipelines.yml"),
      monorepo: workspaces
        || topLevel.has("pnpm-workspace.yaml") || topLevel.has("turbo.json")
        || topLevel.has("lerna.json") || topLevel.has("nx.json")
        || paths.filter((p) => p.endsWith("package.json")).length > 1,
      file_count: paths.length,
      loc_estimate: locEstimate,
      // Hashed: branch names carry ticket ids and feature descriptions.
      git_branch_hash: branch
        ? createHash("sha256").update(branch).digest("hex").slice(0, 16)
        : null,
      dirty_working_tree: Boolean(status && status.trim().length > 0),
    };
    return _cached;
  } catch {
    return null;
  }
}

/** session.started payload, or null outside a git repo. */
export function sessionStartedPayload(root: string): {
  projectId: string | null;
  payload: Record<string, unknown>;
} | null {
  const fp = repoFingerprint(root);
  if (!fp) return null;
  let projectId: string | null = null;
  try { projectId = resolveProjectId(root)?.id ?? null; } catch { /* ignore */ }
  return { projectId, payload: { project_fingerprint: fp } };
}

/** Test seam. */
export function _resetFingerprintCache(): void { _cached = null; }
