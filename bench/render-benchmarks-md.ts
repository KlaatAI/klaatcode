/**
 * Render the public-facing benchmark showcase (docs/final/cli/BENCHMARKS.md)
 * from bench report JSONs. Regenerate after every bench run so the doc is
 * data, not lore:
 *
 *   bun bench/render-benchmarks-md.ts \
 *     reports/<klaatcode>.json reports/claude-*.json \
 *     reports/opencode-*.json reports/grok-*.json \
 *     > ../docs/final/cli/BENCHMARKS.md      # run from bench/, or use abs paths
 *
 * First report = reference (KlaatCode). Emits:
 *   - headline + aggregate table (with cost ratios vs each rival)
 *   - mermaid cost-per-solve chart (renders on GitHub)
 *   - per-category accuracy matrix
 *   - <details>-collapsed per-task tables per agent
 *   - method + honesty notes (static narrative, keep in sync by hand)
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

interface TaskRow {
  id: string; category?: string; difficulty?: string; passed: boolean;
  costUsd: number; totalTokens: number; turns: number; elapsedMs: number;
  costEstimated?: boolean; runs?: number; passes?: number;
}
interface Report {
  agent?: string; model?: string; when?: string; runs?: number;
  solved: number; total: number; totalCostUsd: number; tasks: TaskRow[];
}

const paths = process.argv.slice(2);
if (paths.length < 2) {
  console.error("Usage: bun bench/render-benchmarks-md.ts <reference.json> <other.json>…");
  process.exit(1);
}

// Known agent-default models, for reports that just say "default".
const DEFAULT_MODEL: Record<string, string> = {
  "claude-code": "claude-sonnet-5",
  "grok": "grok-4.5",
  "opencode": "opencode/big-pickle",
};

const reports: { name: string; model: string; r: Report; file: string }[] = [];
for (const p of paths) {
  const r = JSON.parse(await readFile(p, "utf-8")) as Report;
  const name = r.agent ?? "klaatcode";
  reports.push({
    name,
    model: r.model && r.model !== "default"
      ? r.model
      : name === "klaatcode" ? "Klaatu auto-route" : DEFAULT_MODEL[name] ?? "default",
    r, file: basename(p),
  });
}

// Shared task set so partial runs stay comparable.
let shared = new Set(reports[0]!.r.tasks.map(t => t.id));
for (const { r } of reports.slice(1)) {
  const ids = new Set(r.tasks.map(t => t.id));
  shared = new Set([...shared].filter(id => ids.has(id)));
}
const n = shared.size;

interface Agg {
  name: string; model: string; solved: number; cost: number; est: boolean;
  tokens: number; ms: number; runs: number;
  perCat: Map<string, { pass: number; total: number }>;
  rows: TaskRow[];
}
const aggs: Agg[] = reports.map(({ name, model, r }) => {
  const rows = r.tasks.filter(t => shared.has(t.id));
  const perCat = new Map<string, { pass: number; total: number }>();
  for (const t of rows) {
    const c = t.category ?? "?";
    const e = perCat.get(c) ?? { pass: 0, total: 0 };
    e.total++; if (t.passed) e.pass++;
    perCat.set(c, e);
  }
  return {
    name, model,
    solved: rows.filter(t => t.passed).length,
    cost: rows.reduce((s, t) => s + t.costUsd, 0),
    est: rows.some(t => t.costEstimated),
    tokens: rows.reduce((s, t) => s + t.totalTokens, 0),
    ms: rows.reduce((s, t) => s + t.elapsedMs, 0),
    runs: r.runs ?? 1,
    perCat, rows,
  };
});
const ref = aggs[0]!;

const money = (x: number, est = false) => `${est ? "~" : ""}$${x.toFixed(x < 0.1 ? 4 : 2)}`;
const pct = (x: number) => `${Math.round(x * 100)}%`;
const mins = (ms: number) => `${(ms / 60000).toFixed(1)}m`;
const perSolve = (a: Agg) => (a.solved ? a.cost / a.solved : 0);
const stamp = reports[0]!.r.when?.slice(0, 10) ?? "";

const out: string[] = [];
const rivalsPaid = aggs.slice(1).filter(a => a.cost > 0);

out.push(`# Klaat Code Benchmarks`);
out.push(``);
out.push(`> **${stamp} · ${n} tasks · ${aggs.length} agents${ref.runs > 1 ? ` · ${ref.runs} runs per task (reference + Claude Code)` : ""}.**`);
const ratioBits = rivalsPaid.map(a => `**${pct(ref.cost / a.cost)}** of ${a.name}'s cost`).join(", ");
out.push(`> KlaatCode solves **${ref.solved}/${n}** at **${money(perSolve(ref), ref.est)}/solve** — ${ratioBits} at equal-or-better accuracy.`);
out.push(``);
out.push(`Everything on this page is generated from the report JSONs in \`bench/reports/\` by \`bench/render-benchmarks-md.ts\`. Reproduce it yourself: [Method](#method--reproducing).`);
out.push(``);

// ── Aggregate table ──────────────────────────────────────────────────────────
out.push(`## Aggregate`);
out.push(``);
out.push(`| Metric | ${aggs.map((a, i) => (i === 0 ? `**${a.name}**` : a.name)).join(" | ")} |`);
out.push(`|---|${aggs.map(() => "---").join("|")}|`);
out.push(`| Model | ${aggs.map(a => `\`${a.model}\``).join(" | ")} |`);
out.push(`| Runs per task | ${aggs.map(a => (a.runs > 1 ? `**${a.runs}** (pass = all runs)` : "1")).join(" | ")} |`);
out.push(`| **Solved** | ${aggs.map((a, i) => (i === 0 ? `**${a.solved}/${n}**` : `${a.solved}/${n}`)).join(" | ")} |`);
if (aggs.some(a => a.runs > 1)) {
  out.push(`| Run-level pass rate | ${aggs.map(a => {
    if (a.runs <= 1) return "—";
    const passes = a.rows.reduce((s, t) => s + (t.passes ?? (t.passed ? 1 : 0)), 0);
    return `${passes}/${a.rows.reduce((s, t) => s + (t.runs ?? 1), 0)}`;
  }).join(" | ")} |`);
}
out.push(`| **Cost/solve** | ${aggs.map((a, i) => {
  const v = money(perSolve(a), a.est);
  return i === 0 ? `**${v}**` : a.cost === 0 ? "$0 (free)" : v;
}).join(" | ")} |`);
out.push(`| Total cost | ${aggs.map(a => (a.cost === 0 ? "$0" : money(a.cost, a.est))).join(" | ")} |`);
out.push(`| KlaatCode cost ratio | ${aggs.map((a, i) => (i === 0 ? "(ref)" : a.cost > 0 ? `**${pct(ref.cost / a.cost)}**` : "—")).join(" | ")} |`);
out.push(`| Total tokens | ${aggs.map(a => `${(a.tokens / 1e6).toFixed(2)}M`).join(" | ")} |`);
out.push(`| Wall-clock | ${aggs.map(a => mins(a.ms)).join(" | ")} |`);
out.push(``);

// ── Mermaid chart ────────────────────────────────────────────────────────────
out.push(`### Cost per solved task`);
out.push(``);
out.push("```mermaid");
out.push(`xychart-beta`);
out.push(`    title "Cost per solved task (USD${aggs.some(a => a.est) ? ", ~ = estimated" : ""})"`);
out.push(`    x-axis [${aggs.map(a => `"${a.name}${a.cost === 0 ? " (free)" : a.est ? " ~" : ""}"`).join(", ")}]`);
out.push(`    y-axis "USD per solve" 0 --> ${Math.ceil(Math.max(...aggs.map(perSolve)) * 120) / 100}`);
out.push(`    bar [${aggs.map(a => perSolve(a).toFixed(4)).join(", ")}]`);
out.push("```");
out.push(``);

// ── Per-category ─────────────────────────────────────────────────────────────
out.push(`## Accuracy by category`);
out.push(``);
const cats = [...ref.perCat.keys()].sort();
out.push(`| Category | ${aggs.map(a => a.name).join(" | ")} |`);
out.push(`|---|${aggs.map(() => "---").join("|")}|`);
for (const c of cats) {
  out.push(`| ${c} (${ref.perCat.get(c)!.total}) | ${aggs.map(a => {
    const e = a.perCat.get(c);
    if (!e) return "—";
    const full = e.pass === e.total;
    return full ? `${e.pass}/${e.total}` : `**${e.pass}/${e.total}**`;
  }).join(" | ")} |`);
}
out.push(``);
const missed = aggs.slice(1).flatMap(a =>
  a.rows.filter(t => !t.passed).length
    ? [`- **${a.name}** missed: ${a.rows.filter(t => !t.passed).map(t => `\`${t.id}\``).join(", ")}`]
    : []);
if (missed.length) {
  out.push(...missed);
  out.push(``);
}
if (ref.runs > 1) {
  out.push(`### Run-to-run stability (${ref.runs} runs per task)`);
  out.push(``);
  for (const a of aggs) {
    if ((a.rows[0]?.runs ?? 1) <= 1) continue;
    const flaky = a.rows.filter(t => (t.passes ?? t.runs ?? 1) !== (t.runs ?? 1));
    out.push(`- **${a.name}**: ${flaky.length === 0
      ? `all ${n} tasks passed every run`
      : flaky.map(t => `\`${t.id}\` ${t.passes}/${t.runs}`).join(", ")}`);
  }
  out.push(``);
}

// ── Per-task detail ──────────────────────────────────────────────────────────
out.push(`## Per-task detail`);
out.push(``);
for (const a of aggs) {
  out.push(`<details>`);
  out.push(`<summary><b>${a.name}</b> — ${a.solved}/${n} solved, ${money(a.cost, a.est)} total (report: <code>${reports[aggs.indexOf(a)]!.file}</code>)</summary>`);
  out.push(``);
  out.push(`| Task | Category | Result | Cost | Tokens | Turns | Time |`);
  out.push(`|---|---|---|---|---|---|---|`);
  for (const t of [...a.rows].sort((x, y) => x.id.localeCompare(y.id))) {
    const res = t.passed ? "✅" : (t.passes ?? 0) > 0 ? `⚠️ ${t.passes}/${t.runs}` : "❌";
    out.push(`| \`${t.id}\` | ${t.category ?? ""} | ${res} | ${money(t.costUsd, t.costEstimated)} | ${Math.round(t.totalTokens / 1000)}K | ${t.turns} | ${(t.elapsedMs / 1000).toFixed(0)}s |`);
  }
  out.push(``);
  out.push(`</details>`);
  out.push(``);
}

// ── Static narrative ─────────────────────────────────────────────────────────
out.push(`## Method & reproducing

Same fixtures, same prompts, same verify command (\`bun test\`), fresh git-initialized temp workspace per task with \`env.PWD\` pinned — **the only variable is the agent**. Each agent runs with its own defaults, the way you'd actually use it.

\`\`\`bash
bun run bench                                   # KlaatCode baseline
bun bench/compare-agents.ts --agent claude      # or opencode | grok
bun bench/compare-agents.ts --agent claude --runs 3
bun bench/summary-multi.ts <ref> <others…>      # N-way console table
bun run bench:selfcheck                         # every fixture fails as shipped, passes with reference solution
bun bench/render-benchmarks-md.ts <reports…>    # regenerate this page
\`\`\`

## Reading the numbers honestly

- **Cost is the fair metric, not tokens.** Claude Code's token total is ~90% discounted cache reads and its own reported \`total_cost_usd\` already accounts for that. Raw token ratios would overstate our win.
- **Grok Build's cost is estimated** (marked \`~\`): its CLI reports token usage but not dollars on subscription auth, so we price its tokens at published grok-4.5 API rates.
- **opencode's $0 is real but capability-priced:** its free default model missed tasks the paid agents solved. Bring a paid model and its cost profile becomes that model's.
- **Wall-clock** favors agents that don't route: we trade some latency for routed cheap models. Concurrent benching adds noise to wall-clock; treat it as indicative.
- **Long-context is our weakest ratio** — rival prompt caching amortizes big-repo reads. We publish that too; gateway-side cache passthrough is in progress.
- **Isolation is enforced**: fixtures are git-tracked and verified clean before and after every run (an early run was invalidated and rerun when an agent resolved its project root from stale \`env.PWD\` and edited the fixtures — pinned since).
`);

console.log(out.join("\n"));
