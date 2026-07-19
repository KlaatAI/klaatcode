/**
 * Multi-agent comparison run — same suite, same fixtures, same verify command;
 * the only variable is the coding agent.
 *
 * Agents:
 *   claude    — Claude Code headless (`claude -p … --output-format json`);
 *               reports its OWN authoritative cost/usage.
 *   opencode  — opencode headless (`opencode run … --format json`), NDJSON
 *               events; tokens/cost summed from step-finish events. Model
 *               pinned to its as-shipped default (opencode/big-pickle, free).
 *               Promotional-free models (e.g. nemotron-3-ultra-free) report
 *               $0 — cost is ESTIMATED at the model's PAID published rates so
 *               the comparison reflects what the tokens would really cost.
 *   grok      — Grok Build headless (`grok -p … --output-format json`);
 *               reports usage but NOT cost (subscription) — cost is ESTIMATED
 *               from tokens at published grok-4.5 API prices, marked "est".
 *   cursor    — Cursor CLI headless (`cursor-agent -p … --output-format json`);
 *               requires `cursor-agent` installed + logged in. Cost estimated
 *               at published Composer 2.5 standard rates when the CLI does
 *               not report it. UNVERIFIED adapter — flags per cursor.com/docs/cli.
 *
 * Usage:
 *   bun bench/compare-agents.ts --agent opencode
 *   bun bench/compare-agents.ts --agent grok --only fix-fizzbuzz
 *   bun bench/compare-agents.ts --agent claude --from <id>   # resume
 *   bun bench/compare-agents.ts --agent claude --model claude-sonnet-5
 *   bun bench/compare-agents.ts --agent opencode --model opencode/nemotron-3-ultra-free
 *   bun bench/compare-agents.ts --agent cursor --model composer-2.5
 *
 * Report: bench/reports/<agent>-<stamp>.json — same shape as run.ts /
 * compare-claude.ts reports; diff with bench/compare-summary.ts.
 *
 * Isolation: each task runs in a throwaway temp workspace, so permission
 * bypass flags are safe (same isolation the KlaatCode harness uses).
 */

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));

interface Task {
  id: string; dir: string; prompt: string; difficulty?: string;
  category?: string; verify?: string;
}
interface Suite { name: string; verify: string; tasks: Task[] }

interface TaskReport {
  id: string; difficulty?: string; category?: string;
  passed: boolean;
  promptTokens: number; completionTokens: number; totalTokens: number;
  cacheReadTokens: number; cacheCreateTokens: number;
  turns: number; costUsd: number; costEstimated?: boolean; model: string;
  elapsedMs: number; error?: string;
  runs: number; passes: number;
}

interface AgentMetrics {
  costUsd: number; costEstimated?: boolean;
  turns: number; model: string;
  promptTokens: number; completionTokens: number;
  cacheReadTokens: number; cacheCreateTokens: number;
  error?: string;
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const TASK_TIMEOUT_MS = 600_000;

// ─── Adapters ─────────────────────────────────────────────────────────────────

type Adapter = {
  name: string;
  defaultModel: string | undefined;
  run: (prompt: string, cwd: string, model: string | undefined) => AgentMetrics;
};

/**
 * Child env with PWD pinned to the workspace. spawnSync's `cwd` option does
 * NOT rewrite env.PWD, and opencode resolves its project root as
 * `process.env.PWD ?? process.cwd()` — with the stale PWD it operated on THIS
 * repo and edited the original fixtures instead of the temp workspace
 * (observed: silently pre-solving tasks for every later run). Pin PWD for
 * every agent so none can inherit the harness's directory.
 */
function envFor(cwd: string): Record<string, string | undefined> {
  return { ...process.env, PWD: cwd };
}

const claudeAdapter: Adapter = {
  name: "claude-code",
  defaultModel: undefined, // subscription default
  run(prompt, cwd, model) {
    const args = [
      "-p", prompt,
      "--output-format", "json",
      "--dangerously-skip-permissions",
      "--max-turns", "40",
    ];
    if (model) args.push("--model", model);
    const r = spawnSync("claude", args, { cwd, encoding: "utf-8", timeout: TASK_TIMEOUT_MS, env: envFor(cwd) });
    const m: AgentMetrics = { costUsd: 0, turns: 0, model: model ?? "default", promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
    try {
      const out = JSON.parse(r.stdout || "{}") as {
        total_cost_usd?: number; num_turns?: number; is_error?: boolean; subtype?: string;
        usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
        modelUsage?: Record<string, unknown>;
      };
      m.costUsd = out.total_cost_usd ?? 0;
      m.turns = out.num_turns ?? 0;
      m.promptTokens = out.usage?.input_tokens ?? 0;
      m.completionTokens = out.usage?.output_tokens ?? 0;
      m.cacheReadTokens = out.usage?.cache_read_input_tokens ?? 0;
      m.cacheCreateTokens = out.usage?.cache_creation_input_tokens ?? 0;
      const models = Object.keys(out.modelUsage ?? {});
      if (models.length) m.model = models.join("+");
      if (out.is_error) m.error = out.subtype ?? "claude reported error";
    } catch {
      m.error = `unparseable claude output (exit ${r.status})`;
    }
    if (r.status !== 0 && !m.error) m.error = `claude exited ${r.status}`;
    return m;
  },
};

/**
 * Published PAID rates (USD per 1M tokens) for models served free promotionally.
 * A $0 bill on a promo model says nothing about real-world cost — estimate at
 * the paid rate and mark the report estimated. Cache-read billed at the input
 * rate (no published discount).
 * Nemotron 3 Ultra: openrouter.ai/nvidia/nemotron-3-ultra-550b-a55b (2026-07).
 */
const PROMO_MODEL_PAID_PRICES: Array<{ match: RegExp; input: number; output: number; cacheRead: number }> = [
  { match: /nemotron-3-ultra/i, input: 0.50, output: 2.20, cacheRead: 0.50 },
];

const opencodeAdapter: Adapter = {
  name: "opencode",
  // As-shipped default: opencode's free zen model. Pinned for reproducibility.
  defaultModel: "opencode/big-pickle",
  run(prompt, cwd, model) {
    const args = ["run", prompt, "--format", "json"];
    if (model) args.push("-m", model);
    const r = spawnSync("opencode", args, { cwd, encoding: "utf-8", timeout: TASK_TIMEOUT_MS, env: envFor(cwd) });
    if (process.env["BENCH_DEBUG_DIR"]) {
      try {
        const fs = require("node:fs");
        const stamp = Date.now();
        fs.writeFileSync(`${process.env["BENCH_DEBUG_DIR"]}/opencode-${stamp}.out`, (r.stdout ?? "") + "\n─── STDERR ───\n" + (r.stderr ?? ""));
      } catch { /* debug only */ }
    }
    const m: AgentMetrics = { costUsd: 0, turns: 0, model: model ?? "default", promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
    // NDJSON event stream — sum every step-finish part.
    for (const line of (r.stdout || "").split("\n")) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      try {
        const ev = JSON.parse(t) as {
          type?: string;
          part?: { type?: string; cost?: number; tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } } };
        };
        if (ev.type === "step_finish" && ev.part?.type === "step-finish") {
          m.turns++;
          m.costUsd += ev.part.cost ?? 0;
          m.promptTokens += ev.part.tokens?.input ?? 0;
          m.completionTokens += (ev.part.tokens?.output ?? 0) + (ev.part.tokens?.reasoning ?? 0);
          m.cacheReadTokens += ev.part.tokens?.cache?.read ?? 0;
          m.cacheCreateTokens += ev.part.tokens?.cache?.write ?? 0;
        }
      } catch { /* skip malformed line */ }
    }
    if (r.status !== 0) m.error = `opencode exited ${r.status ?? "signal"}`;
    else if (m.turns === 0) m.error = "no step-finish events parsed";
    // Promo-free model: replace the $0 bill with an estimate at paid rates.
    const promo = PROMO_MODEL_PAID_PRICES.find(p => p.match.test(model ?? ""));
    if (promo && m.costUsd === 0) {
      m.costEstimated = true;
      m.costUsd =
        (m.promptTokens * promo.input +
         m.cacheReadTokens * promo.cacheRead +
         m.completionTokens * promo.output) / 1_000_000;
    }
    return m;
  },
};

// grok-4.5 published API prices (USD per 1M tokens) — used only because the
// grok CLI does not report cost on subscription auth. Marked estimated.
const GROK_PRICES = { input: 3, output: 15, cacheRead: 0.75 };

const grokAdapter: Adapter = {
  name: "grok",
  defaultModel: undefined, // subscription default (grok-4.5 as of 2026-07)
  run(prompt, cwd, model) {
    const bin = join(homedir(), ".grok", "bin", "grok");
    const args = [
      "-p", prompt,
      "--output-format", "json",
      "--permission-mode", "bypassPermissions",
    ];
    if (model) args.push("-m", model);
    const r = spawnSync(bin, args, { cwd, encoding: "utf-8", timeout: TASK_TIMEOUT_MS, env: envFor(cwd) });
    const m: AgentMetrics = { costUsd: 0, costEstimated: true, turns: 0, model: model ?? "default", promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
    try {
      const out = JSON.parse(r.stdout || "{}") as {
        num_turns?: number; is_error?: boolean; error?: string;
        usage?: { input_tokens?: number; output_tokens?: number; reasoning_tokens?: number; cache_read_input_tokens?: number };
        modelUsage?: Record<string, unknown>;
      };
      m.turns = out.num_turns ?? 0;
      m.promptTokens = out.usage?.input_tokens ?? 0;
      m.completionTokens = (out.usage?.output_tokens ?? 0) + (out.usage?.reasoning_tokens ?? 0);
      m.cacheReadTokens = out.usage?.cache_read_input_tokens ?? 0;
      const models = Object.keys(out.modelUsage ?? {});
      if (models.length) m.model = models.join("+");
      // input_tokens already includes cache reads on grok's report; bill the
      // non-cached share at full rate and cached share at the cached rate.
      const freshIn = Math.max(0, m.promptTokens - m.cacheReadTokens);
      m.costUsd =
        (freshIn * GROK_PRICES.input +
         m.cacheReadTokens * GROK_PRICES.cacheRead +
         m.completionTokens * GROK_PRICES.output) / 1_000_000;
      if (out.is_error) m.error = out.error ?? "grok reported error";
    } catch {
      m.error = `unparseable grok output (exit ${r.status})`;
    }
    if (r.status !== 0 && !m.error) {
      // Free-tier throttle surfaces on stderr with exit 1 — a rate-limited
      // task is an invalid sample, not a capability miss. Label it so.
      m.error = /usage limit/i.test(r.stderr ?? "")
        ? "rate-limited (invalid sample — rerun later)"
        : `grok exited ${r.status}`;
    }
    return m;
  },
};

// Composer 2.5 standard rates (USD per 1M tokens) — cursor.com/docs/models
// (2026-07: $0.50 in / $2.50 out; the -fast tier is $3/$15). Used only when
// the CLI does not report cost. Cache-read billed at input rate (no published
// discount).
const COMPOSER_PRICES = { input: 0.50, output: 2.50, cacheRead: 0.50 };

/**
 * Cursor CLI adapter — UNVERIFIED (no cursor-agent on the dev machine).
 * Flags per cursor.com/docs/cli: `-p` print mode, `--output-format json`
 * (single JSON object on completion), `--force` auto-approves edits/commands
 * (safe: throwaway workspace), `--model composer-2.5`.
 * Verify the JSON field names on the first real run before citing numbers.
 */
const cursorAdapter: Adapter = {
  name: "cursor",
  defaultModel: "composer-2.5",
  run(prompt, cwd, model) {
    const m: AgentMetrics = { costUsd: 0, turns: 0, model: model ?? "default", promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
    const probe = spawnSync("cursor-agent", ["--version"], { encoding: "utf-8", timeout: 10_000 });
    if (probe.error || probe.status !== 0) {
      m.error = "cursor-agent not installed — install via `curl https://cursor.com/install -fsS | bash` and log in";
      return m;
    }
    const args = [
      "-p", prompt,
      "--output-format", "json",
      "--force",
    ];
    if (model) args.push("--model", model);
    const r = spawnSync("cursor-agent", args, { cwd, encoding: "utf-8", timeout: TASK_TIMEOUT_MS, env: envFor(cwd) });
    try {
      // Docs: json format emits one object at completion. Field names mirror
      // the claude-style schema; parse defensively and fall back to estimates.
      const out = JSON.parse(r.stdout || "{}") as {
        total_cost_usd?: number; cost_usd?: number; num_turns?: number;
        is_error?: boolean; subtype?: string; error?: string;
        usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
        model?: string;
      };
      m.turns = out.num_turns ?? 0;
      m.promptTokens = out.usage?.input_tokens ?? 0;
      m.completionTokens = out.usage?.output_tokens ?? 0;
      m.cacheReadTokens = out.usage?.cache_read_input_tokens ?? 0;
      m.cacheCreateTokens = out.usage?.cache_creation_input_tokens ?? 0;
      if (out.model) m.model = out.model;
      const reported = out.total_cost_usd ?? out.cost_usd;
      if (reported !== undefined) {
        m.costUsd = reported;
      } else {
        m.costEstimated = true;
        m.costUsd =
          (m.promptTokens * COMPOSER_PRICES.input +
           m.cacheReadTokens * COMPOSER_PRICES.cacheRead +
           m.completionTokens * COMPOSER_PRICES.output) / 1_000_000;
      }
      if (out.is_error) m.error = out.error ?? out.subtype ?? "cursor reported error";
      if (!m.error && m.promptTokens === 0 && m.completionTokens === 0) {
        m.error = "cursor CLI reported no usage — inspect raw output before trusting cost";
      }
    } catch {
      m.error = `unparseable cursor output (exit ${r.status})`;
    }
    if (r.status !== 0 && !m.error) m.error = `cursor exited ${r.status}`;
    return m;
  },
};

const ADAPTERS: Record<string, Adapter> = {
  claude: claudeAdapter,
  opencode: opencodeAdapter,
  grok: grokAdapter,
  cursor: cursorAdapter,
};

// ─── Runner ───────────────────────────────────────────────────────────────────

async function runTask(suite: Suite, task: Task, adapter: Adapter, model: string | undefined): Promise<Omit<TaskReport, "runs" | "passes">> {
  const fixture = resolve(HERE, task.dir);
  const work = await mkdtemp(join(tmpdir(), `${adapter.name}-${task.id}-`));
  try {
    await cp(fixture, work, { recursive: true });
    // Make the workspace a standalone git repo so agents that resolve their
    // project root by walking up anchor here (and see a realistic repo).
    // The actual fixture-pollution culprit was stale env.PWD — see envFor().
    spawnSync("git", ["init", "-q"], { cwd: work, encoding: "utf-8", timeout: 10_000 });
    spawnSync("git", ["add", "-A"], { cwd: work, encoding: "utf-8", timeout: 10_000 });
    spawnSync("git", ["-c", "user.email=bench@klaatai.com", "-c", "user.name=bench", "commit", "-qm", "fixture"], { cwd: work, encoding: "utf-8", timeout: 10_000 });

    const started = performance.now();
    const m = adapter.run(task.prompt, work, model);
    const elapsedMs = Math.round(performance.now() - started);

    const verifyCmd = task.verify ?? suite.verify;
    const [cmd, ...cmdArgs] = verifyCmd.split(" ");
    const v = spawnSync(cmd!, cmdArgs, { cwd: work, encoding: "utf-8", timeout: 60_000 });
    const passed = v.status === 0;

    return {
      id: task.id, difficulty: task.difficulty, category: task.category, passed,
      promptTokens: m.promptTokens, completionTokens: m.completionTokens,
      totalTokens: m.promptTokens + m.completionTokens + m.cacheReadTokens + m.cacheCreateTokens,
      cacheReadTokens: m.cacheReadTokens, cacheCreateTokens: m.cacheCreateTokens,
      turns: m.turns, costUsd: m.costUsd, costEstimated: m.costEstimated,
      model: m.model, elapsedMs, error: m.error,
    };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

async function main(): Promise<void> {
  const agentName = arg("agent");
  const adapter = agentName ? ADAPTERS[agentName] : undefined;
  if (!adapter) {
    console.error(`Pass --agent ${Object.keys(ADAPTERS).join("|")}`);
    process.exit(1);
  }

  const suite = JSON.parse(await readFile(resolve(HERE, "suite.json"), "utf-8")) as Suite;
  const only = arg("only");
  const from = arg("from");
  const category = arg("category");
  const model = arg("model") ?? adapter.defaultModel;
  const runs = Math.max(1, Number(arg("runs", "1")));

  let tasks = only ? suite.tasks.filter(t => t.id === only) : suite.tasks;
  if (category) tasks = tasks.filter(t => t.category === category);
  if (from) {
    const i = tasks.findIndex(t => t.id === from);
    if (i === -1) { console.error(`No task matches --from ${from}`); process.exit(1); }
    tasks = tasks.slice(i);
  }
  if (!tasks.length) { console.error("No task matches the given filters"); process.exit(1); }

  console.log(`\n  ${adapter.name} comparison — ${tasks.length} task(s), ${runs} run(s) each, model=${model ?? "default"}\n`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = resolve(HERE, "reports");
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `${agentName}-${stamp}.json`);
  const saveReport = async (reports: TaskReport[], done: boolean) => {
    const solved = reports.filter(r => r.passed).length;
    await writeFile(outPath, JSON.stringify({
      suite: suite.name, agent: adapter.name, model: model ?? "default",
      when: stamp, complete: done, runs,
      costEstimated: reports.some(r => r.costEstimated),
      solved, total: reports.length, planned: tasks.length,
      totalCostUsd: reports.reduce((s, r) => s + r.costUsd, 0),
      totalTokens: reports.reduce((s, r) => s + r.totalTokens, 0),
      tasks: reports,
    }, null, 2));
  };

  const reports: TaskReport[] = [];
  for (const task of tasks) {
    process.stdout.write(`  ▸ ${task.id.padEnd(28)} `);
    // Same semantics as run.ts: passed = all runs pass; cost/tokens/turns
    // averaged across runs so N-run reports stay comparable to 1-run ones.
    const rr: Omit<TaskReport, "runs" | "passes">[] = [];
    for (let i = 0; i < runs; i++) rr.push(await runTask(suite, task, adapter, model));
    const passes = rr.filter(x => x.passed).length;
    const avg = (f: (x: typeof rr[number]) => number) => rr.reduce((s, x) => s + f(x), 0) / runs;
    const rep: TaskReport = {
      ...rr[rr.length - 1]!,
      runs, passes, passed: passes === runs,
      costUsd: avg(x => x.costUsd),
      promptTokens: Math.round(avg(x => x.promptTokens)),
      completionTokens: Math.round(avg(x => x.completionTokens)),
      cacheReadTokens: Math.round(avg(x => x.cacheReadTokens)),
      cacheCreateTokens: Math.round(avg(x => x.cacheCreateTokens)),
      totalTokens: Math.round(avg(x => x.totalTokens)),
      turns: Math.round(avg(x => x.turns)),
      elapsedMs: Math.round(avg(x => x.elapsedMs)),
      error: rr.map(x => x.error).filter(Boolean).join("; ") || undefined,
    };
    reports.push(rep);
    await saveReport(reports, false); // incremental — abort-safe
    const mark = rep.passed ? "PASS" : passes > 0 ? `FLAKY ${passes}/${runs}` : "FAIL";
    const est = rep.costEstimated ? "~" : "";
    console.log(`${mark}  ${est}$${rep.costUsd.toFixed(4)}  ${rep.totalTokens} tok (${rep.cacheReadTokens} cached)  ${rep.turns} turns  ${(rep.elapsedMs / 1000).toFixed(0)}s${rep.error ? `  (${rep.error})` : ""}`);
  }

  const solved = reports.filter(r => r.passed).length;
  const totalCost = reports.reduce((s, r) => s + r.costUsd, 0);
  const est = reports.some(r => r.costEstimated) ? " (estimated)" : "";
  console.log(`\n  ── Summary ─────────────────────────────`);
  console.log(`  Solved:     ${solved}/${reports.length}`);
  console.log(`  Total cost: $${totalCost.toFixed(4)}${est}`);
  console.log(`  Cost/solve: ${solved ? `$${(totalCost / solved).toFixed(4)}` : "—"}${est}`);

  await saveReport(reports, true);
  console.log(`\n  Report: ${outPath}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
