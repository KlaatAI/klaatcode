/**
 * KlaatCode benchmark harness (Phase 7).
 *
 * For each task in suite.json:
 *   1. Copy the fixture dir into a fresh temp workspace.
 *   2. Run the headless agent (real tools, sandboxed to the workspace) on the
 *      task prompt.
 *   3. Run the verify command (default `bun test`) in the workspace. Exit 0 = pass.
 *   4. Record success + cost + tokens + turns + tool calls + wall-clock.
 *
 * Emits a table to stdout and a JSON report to bench/reports/<stamp>.json.
 * The JSON is the artifact you diff against Claude Code / across model configs.
 *
 * Usage:
 *   bun bench/run.ts                 # whole suite, auto-route
 *   bun bench/run.ts --tier code     # pin a tier
 *   bun bench/run.ts --only fix-fizzbuzz
 *   bun bench/run.ts --runs 3        # repeat each task, report pass-rate
 *   bun bench/run.ts --from implement-lru-cache   # resume mid-suite (quota abort)
 *   bun bench/run.ts --category bugfix            # one category only
 *
 * The report JSON is written incrementally after EVERY task, so a mid-suite
 * abort (daily quota, ctrl-c, crash) still leaves a usable partial report.
 * Suite integrity: `bun bench/selfcheck.ts` (no agent, no tokens).
 */

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { KlaatAIClient, type Message } from "../src/api/client.js";
import { runHeadlessAgent } from "../src/agent/headless-agent.js";
import { configureSandbox } from "../src/tools/index.js";
import { seedSystemMessages } from "../src/agent/system-prompt.js";
import { loadConfig } from "../src/auth/credentials.js";
import { getValidAuthToken, forceRefreshToken } from "../src/auth/refresh.js";

const HERE = dirname(fileURLToPath(import.meta.url));

interface Task {
  id: string; dir: string; prompt: string; difficulty?: string;
  category?: string; verify?: string;
}
interface Suite { name: string; description: string; verify: string; tasks: Task[]; }

interface TaskReport {
  id: string; difficulty?: string; category?: string;
  passed: boolean; runs: number; passes: number;
  promptTokens: number; completionTokens: number; totalTokens: number; estTokens: number;
  requests: number; usageEvents: number; partialUsage: boolean;
  turns: number; toolCalls: number; costUsd: number;
  tiers: Record<string, number>; lastModel: string; elapsedMs: number;
  stoppedBy: string; error?: string;
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function runTask(
  client: KlaatAIClient, suite: Suite, task: Task, tier: string | undefined,
): Promise<Omit<TaskReport, "runs" | "passes">> {
  const fixture = resolve(HERE, task.dir);
  const work = await mkdtemp(join(tmpdir(), `klbench-${task.id}-`));
  try {
    await cp(fixture, work, { recursive: true });
    // Sandbox every write to this workspace — the agent runs with NO prompts.
    configureSandbox({ enabled: true, root: work, allow: [work] });

    const messages: Message[] = [
      ...seedSystemMessages(work),
      { role: "user", content: task.prompt },
    ];

    const r = await runHeadlessAgent(client, messages, work, {
      tier, maxTurns: 40, now: () => performance.now(),
      onProgress: (ev) => { if (ev.kind === "tool") process.stdout.write("."); },
    });

    // Verify: run the task/suite command in the workspace.
    const verifyCmd = task.verify ?? suite.verify;
    const [cmd, ...cmdArgs] = verifyCmd.split(" ");
    const v = spawnSync(cmd!, cmdArgs, { cwd: work, encoding: "utf-8", timeout: 60_000 });
    const passed = v.status === 0;

    // Combine authoritative server usage with char/4 estimates for the
    // requests the server didn't report — so multi-turn totals aren't zero.
    return {
      id: task.id, difficulty: task.difficulty, category: task.category, passed,
      promptTokens: r.promptTokens, completionTokens: r.completionTokens,
      totalTokens: r.promptTokens + r.completionTokens + r.estPromptTokens + r.estCompletionTokens,
      estTokens: r.estPromptTokens + r.estCompletionTokens,
      requests: r.requests, usageEvents: r.usageEvents, partialUsage: r.partialUsage,
      turns: r.turns, toolCalls: r.toolCalls,
      costUsd: r.costUsd + r.estCostUsd, tiers: r.tiers, lastModel: r.lastModel,
      elapsedMs: Math.round(r.elapsedMs),
      stoppedBy: r.stoppedBy, error: r.error,
    };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

async function main(): Promise<void> {
  const suite = JSON.parse(await readFile(resolve(HERE, process.env.BENCH_SUITE ?? "suite.json"), "utf-8")) as Suite;
  const tier = arg("tier");
  const only = arg("only");
  const from = arg("from");
  const category = arg("category");
  const runs = Math.max(1, Number(arg("runs", "1")));
  let tasks = only ? suite.tasks.filter(t => t.id === only) : suite.tasks;
  if (category) tasks = tasks.filter(t => t.category === category);
  if (from) {
    const i = tasks.findIndex(t => t.id === from);
    if (i === -1) { console.error(`No task matches --from ${from}`); process.exit(1); }
    tasks = tasks.slice(i);
  }

  if (!tasks.length) { console.error(`No task matches the given filters`); process.exit(1); }

  const config = loadConfig();
  // Honor the same corporate-MITM escape hatch the TUI uses (config.insecureTls).
  if (config.insecureTls && !process.env["NODE_TLS_REJECT_UNAUTHORIZED"]) {
    process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
  }
  const apiKey = process.env["KLAATAI_API_KEY"] ?? await getValidAuthToken();
  if (!apiKey) { console.error("No API key. Run: klaatai login"); process.exit(1); }
  // Long suite runs can outlive the 1h access token — silent refresh on 401
  // (no browser fallback here; headless runs just fail if the refresh
  // token is dead).
  const client = new KlaatAIClient({
    apiKey, baseUrl: config.baseUrl,
    onAuthExpired: () => forceRefreshToken(),
  });

  console.log(`\n  ${suite.name} — ${tasks.length} task(s), ${runs} run(s) each${tier ? `, tier=${tier}` : ", auto-route"}\n`);

  // Report path fixed up-front; rewritten after every task so a mid-suite
  // abort (daily quota, crash) still leaves a usable partial report.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = resolve(HERE, "reports");
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `${stamp}.json`);
  const saveReport = async (reports: TaskReport[], done: boolean) => {
    const solved = reports.filter(r => r.passed).length;
    await writeFile(outPath, JSON.stringify({
      suite: suite.name, tier: tier ?? "auto", runs, when: stamp, complete: done,
      solved, total: reports.length, planned: tasks.length,
      totalCostUsd: reports.reduce((s, r) => s + r.costUsd, 0),
      totalTokens: reports.reduce((s, r) => s + r.totalTokens, 0),
      tasks: reports,
    }, null, 2));
  };

  const reports: TaskReport[] = [];
  for (const task of tasks) {
    process.stdout.write(`  ▸ ${task.id.padEnd(20)} `);
    const rr: Awaited<ReturnType<typeof runTask>>[] = [];
    for (let i = 0; i < runs; i++) rr.push(await runTask(client, suite, task, tier));

    const passes = rr.filter(x => x.passed).length;
    const agg = rr[0]!; // representative run for token/cost display
    const rep: TaskReport = {
      ...agg, runs, passes,
      passed: passes === runs,
      // average cost/tokens across runs
      costUsd: rr.reduce((s, x) => s + x.costUsd, 0) / runs,
      totalTokens: Math.round(rr.reduce((s, x) => s + x.totalTokens, 0) / runs),
      turns: Math.round(rr.reduce((s, x) => s + x.turns, 0) / runs),
      toolCalls: Math.round(rr.reduce((s, x) => s + x.toolCalls, 0) / runs),
    };
    reports.push(rep);
    await saveReport(reports, false); // incremental — abort-safe
    const mark = rep.passes === runs ? "PASS" : rep.passes === 0 ? "FAIL" : `${rep.passes}/${runs}`;
    const partial = rep.partialUsage ? " ~" : "";  // ~ = includes char/4 estimate (server sent no usage on some requests)
    console.log(` ${mark}  $${rep.costUsd.toFixed(4)}  ${rep.totalTokens}${partial} tok  ${rep.turns} turns${rep.error ? `  (${rep.error})` : ""}`);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const solved = reports.filter(r => r.passed).length;
  const totalCost = reports.reduce((s, r) => s + r.costUsd, 0);
  const totalTok = reports.reduce((s, r) => s + r.totalTokens, 0);
  console.log(`\n  ── Summary ─────────────────────────────`);
  console.log(`  Solved:     ${solved}/${reports.length}`);
  console.log(`  Total cost: $${totalCost.toFixed(4)}`);
  console.log(`  Total tok:  ${totalTok}`);
  console.log(`  Cost/solve: ${solved ? `$${(totalCost / solved).toFixed(4)}` : "—"}`);
  const byCat = new Map<string, { pass: number; total: number }>();
  for (const r of reports) {
    const c = byCat.get(r.category ?? "other") ?? { pass: 0, total: 0 };
    c.total++; if (r.passed) c.pass++;
    byCat.set(r.category ?? "other", c);
  }
  if (byCat.size > 1) {
    for (const [cat, c] of byCat) console.log(`    ${cat.padEnd(12)} ${c.pass}/${c.total}`);
  }
  if (reports.some(r => r.partialUsage)) {
    console.log(`  Note: ~ = includes char/4 token estimate for requests the server didn't report usage on.`);
  }

  await saveReport(reports, true);
  console.log(`\n  Report: ${outPath}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
