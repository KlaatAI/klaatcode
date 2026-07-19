/**
 * Export the latest complete bench reports as one normalized JSON for the
 * website's interactive benchmarks page (KlaatAi.Klaatu.UI /benchmarks).
 *
 * Picks the NEWEST report with `complete: true` for each agent:
 *   - klaatcode: unprefixed `<stamp>.json` (bench/run.ts output, no agent key)
 *   - claude / opencode / grok / cursor: `<agent>-<stamp>.json`
 *
 * Usage:
 *   bun bench/export-benchmarks-json.ts                # default out path
 *   bun bench/export-benchmarks-json.ts --out path.json
 *   bun bench/export-benchmarks-json.ts --min-tasks 33 # skip partial suites
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORTS = join(HERE, "reports");

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const OUT = resolve(
  arg("out") ??
  join(HERE, "..", "..", "KlaatAi.Klaatu.UI", "src", "content", "benchmarks.json"),
);
const MIN_TASKS = Number(arg("min-tasks", "30"));

interface RawTask {
  id: string; difficulty?: string; category?: string; passed: boolean;
  promptTokens: number; completionTokens: number; totalTokens: number;
  turns: number; costUsd: number; costEstimated?: boolean;
  elapsedMs: number; error?: string; runs: number; passes: number;
  model?: string; lastModel?: string;
}
interface RawReport {
  suite: string; agent?: string; model?: string; tier?: string;
  when: string; complete: boolean; runs: number;
  solved: number; total: number; totalCostUsd: number; totalTokens: number;
  costEstimated?: boolean; tasks: RawTask[];
}

/** Display metadata per agent id. KlaatCode always listed first. */
const AGENT_META: Record<string, { label: string; model: string; note?: string; highlight?: boolean }> = {
  klaatcode: { label: "Klaat Code", model: "Klaatu smart routing", highlight: true },
  claude:    { label: "Claude Code", model: "Sonnet 5" },
  opencode:  { label: "opencode", model: "Nemotron 3 Ultra (promo-free)", note: "served free promotionally — cost estimated at the paid rate ($0.50/$2.20 per MTok) so the comparison reflects real token cost" },
  grok:      { label: "Grok Build", model: "grok-4.5", note: "subscription auth reports no cost — estimated at published grok-4.5 API rates" },
  cursor:    { label: "Cursor", model: "Composer 2.5 Fast", note: "run via Cursor IDE agent chat (single session) — measured 953K tokens normalized at composer-2.5-fast published rates ($3/$15 per MTok) for comparability, same treatment as the promo-priced lanes; actual subsidized on-demand billing was $0.08. Per-task timings approximate; no per-task token counts" },
};

function latestCompleteReport(files: string[], matches: (f: string) => boolean): RawReport | null {
  const candidates = files.filter(matches).sort().reverse();
  for (const f of candidates) {
    try {
      const r = JSON.parse(readFileSync(join(REPORTS, f), "utf-8")) as RawReport;
      if (r.complete && r.tasks.length >= MIN_TASKS) return r;
    } catch { /* skip unreadable */ }
  }
  return null;
}

const files = readdirSync(REPORTS).filter(f => f.endsWith(".json"));

const picks: Record<string, RawReport | null> = {
  klaatcode: latestCompleteReport(files, f => /^\d{4}-/.test(f)),
  claude:    latestCompleteReport(files, f => f.startsWith("claude-")),
  opencode:  latestCompleteReport(files, f => f.startsWith("opencode-")),
  grok:      latestCompleteReport(files, f => f.startsWith("grok-")),
  cursor:    latestCompleteReport(files, f => f.startsWith("cursor-")),
};

const agents = Object.entries(picks)
  .filter((e): e is [string, RawReport] => e[1] !== null)
  .map(([id, r]) => {
    const meta = AGENT_META[id] ?? { label: id, model: r.model ?? "default" };
    const solvedTasks = r.tasks.filter(t => t.passed);
    const med = (xs: number[]): number => {
      if (!xs.length) return 0;
      const s = [...xs].sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)]!;
    };
    return {
      id,
      label: meta.label,
      model: r.model && r.model !== "default" ? r.model : meta.model,
      highlight: meta.highlight ?? false,
      note: meta.note,
      when: r.when,
      runsPerTask: r.runs,
      solved: r.solved,
      total: r.total,
      solveRate: r.total ? r.solved / r.total : 0,
      totalCostUsd: r.totalCostUsd,
      costEstimated: r.costEstimated ?? r.tasks.some(t => t.costEstimated),
      costPerSolve: r.solved ? r.totalCostUsd / r.solved : null,
      tokensPerSolve: r.solved
        ? Math.round(solvedTasks.reduce((s, t) => s + t.totalTokens, 0) / r.solved)
        : null,
      medianTaskSeconds: Math.round(med(r.tasks.map(t => t.elapsedMs)) / 100) / 10,
      tasks: r.tasks.map(t => ({
        id: t.id,
        category: t.category ?? "general",
        difficulty: t.difficulty ?? "normal",
        passed: t.passed,
        flaky: t.passes > 0 && t.passes < t.runs,
        costUsd: Math.round(t.costUsd * 10_000) / 10_000,
        costEstimated: t.costEstimated ?? false,
        totalTokens: t.totalTokens,
        turns: t.turns,
        seconds: Math.round(t.elapsedMs / 100) / 10,
        error: t.error,
      })),
    };
  });

if (!agents.length) {
  console.error("No complete reports found — run the bench first.");
  process.exit(1);
}

// Task list from the highlight agent (or the first), for the matrix rows.
const base = agents.find(a => a.highlight) ?? agents[0]!;
const taskIndex = base.tasks.map(t => ({ id: t.id, category: t.category, difficulty: t.difficulty }));

const out = {
  generated: new Date().toISOString(),
  suite: picks[base.id]!.suite,
  taskCount: base.total,
  methodologyUrl: "https://github.com/KlaatAI/klaatcode/tree/main/bench",
  agents,
  taskIndex,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`Exported ${agents.length} agents (${agents.map(a => `${a.id}:${a.solved}/${a.total}`).join(", ")})`);
console.log(`→ ${OUT}`);
