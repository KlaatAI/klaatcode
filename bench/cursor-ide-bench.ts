/**
 * Cursor IDE chat bench lane — for when `cursor-agent` (headless CLI) is
 * unusable. The Cursor IDE agent itself works through the suite inside a
 * prepared folder; an objective check script records pass/fail, and the
 * account-level cost delta from the Cursor dashboard supplies total cost.
 *
 * Methodology differs from the CLI lanes (single chat session, no fresh
 * process per task, no per-task token counts) — the imported report is
 * tagged so the website note can say so.
 *
 * Usage:
 *   bun bench/cursor-ide-bench.ts prepare [--out ~/cursor-ide-bench]
 *     → builds the workspace + PASTE_PROMPT.md to paste into Cursor chat
 *   bun bench/cursor-ide-bench.ts import --cost 3.21 [--out ~/cursor-ide-bench]
 *     → converts results.json into bench/reports/cursor-<stamp>.json
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));

interface Task { id: string; dir: string; prompt: string; difficulty?: string; category?: string; verify?: string }
interface Suite { name: string; verify: string; tasks: Task[] }

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const suite = JSON.parse(readFileSync(resolve(HERE, "suite.json"), "utf-8")) as Suite;
const OUT = resolve((arg("out") ?? join(homedir(), "cursor-ide-bench")).replace(/^~/, homedir()));
const mode = process.argv[2];

if (mode === "prepare") {
  if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  for (const t of suite.tasks) {
    const dest = join(OUT, t.id);
    cpSync(resolve(HERE, t.dir), dest, { recursive: true });
    writeFileSync(join(dest, "_PROMPT.md"), `${t.prompt}\n`);
    // Anchor each task folder as its own repo so the agent sees a clean tree.
    for (const cmd of [["init", "-q"], ["add", "-A"], ["-c", "user.email=bench@klaatai.com", "-c", "user.name=bench", "commit", "-qm", "fixture"]]) {
      spawnSync("git", cmd, { cwd: dest, encoding: "utf-8", timeout: 10_000 });
    }
  }

  writeFileSync(join(OUT, "manifest.json"), JSON.stringify({
    suite: suite.name,
    verify: suite.verify,
    startedAt: new Date().toISOString(),
    tasks: suite.tasks.map(t => ({ id: t.id, category: t.category, difficulty: t.difficulty, verify: t.verify ?? suite.verify })),
  }, null, 2));

  // Objective referee: runs the verify command, appends one line to results.json.
  writeFileSync(join(OUT, "run-check.sh"), `#!/bin/bash
# Usage: bash run-check.sh <task-id> — run from the bench root folder.
set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"
ID="\${1:?task id required}"
VERIFY=$(python3 -c "import json;m=json.load(open('$ROOT/manifest.json'));print(next(t['verify'] for t in m['tasks'] if t['id']=='\$ID'))" 2>/dev/null || echo "${suite.verify}")
cd "$ROOT/\$ID" || exit 1
\$VERIFY >/dev/null 2>&1
PASSED=\$?
python3 - "$ROOT/results.json" "\$ID" "\$PASSED" <<'PY'
import json, sys, datetime, os
path, tid, status = sys.argv[1], sys.argv[2], sys.argv[3]
rows = json.load(open(path)) if os.path.exists(path) else []
rows = [r for r in rows if r["id"] != tid]
rows.append({"id": tid, "passed": status == "0", "at": datetime.datetime.now(datetime.timezone.utc).isoformat()})
json.dump(rows, open(path, "w"), indent=1)
PY
if [ "\$PASSED" = "0" ]; then echo "RESULT \$ID: PASS"; else echo "RESULT \$ID: FAIL"; fi
`);

  const taskList = suite.tasks.map((t, i) => `${i + 1}. ${t.id}`).join("\n");
  writeFileSync(join(OUT, "PASTE_PROMPT.md"), `Open the folder ${OUT} in Cursor, then paste everything below into a fresh agent chat.

---

You are being benchmarked. Work through 33 independent coding tasks, strictly one at a time, in this exact order:

${taskList}

For EACH task, follow exactly this loop:

1. Read \`<task-id>/_PROMPT.md\` and treat its contents as the task instructions. All file edits must stay inside that task's folder.
2. Solve the task.
3. Run \`bash run-check.sh <task-id>\` from the root folder and wait for its RESULT line.
4. Whatever the result (PASS or FAIL), immediately move to the next task. Never retry a task after its check, never revisit earlier folders.

Rules: do not edit \`run-check.sh\`, \`manifest.json\`, \`results.json\`, or any \`_PROMPT.md\`; do not use information from one task in another; no questions, no commentary between tasks — just work. After the final check, reply only: BENCH COMPLETE.
`);

  console.log(`Prepared ${suite.tasks.length} tasks in ${OUT}`);
  console.log(`\nNext steps:`);
  console.log(`  1. Note your current usage cost in the Cursor dashboard (cursor.com/dashboard).`);
  console.log(`  2. Open ${OUT} in Cursor and paste the contents of PASTE_PROMPT.md into agent chat.`);
  console.log(`  3. When it prints BENCH COMPLETE, note the dashboard cost again.`);
  console.log(`  4. bun bench/cursor-ide-bench.ts import --cost <delta-usd>`);
} else if (mode === "import") {
  const cost = Number(arg("cost"));
  if (!Number.isFinite(cost)) { console.error("Pass --cost <usd> (Cursor dashboard usage delta for the run)"); process.exit(1); }
  // Optional: total tokens for the run, from the dashboard usage table
  // (Export CSV → sum the composer-2.5 rows in the run window).
  const tokens = Number(arg("tokens", "0"));
  // Which Composer variant actually served (check the dashboard Model column).
  const modelName = `${arg("model", "composer-2.5-fast")} (IDE chat)`;
  const results = JSON.parse(readFileSync(join(OUT, "results.json"), "utf-8")) as { id: string; passed: boolean; at: string }[];
  const manifest = JSON.parse(readFileSync(join(OUT, "manifest.json"), "utf-8")) as { startedAt: string; tasks: { id: string; category?: string; difficulty?: string }[] };
  const byId = new Map(results.map(r => [r.id, r]));

  // Checks run batched at the end of the session, so per-task timestamp
  // deltas are meaningless — spread total wall clock evenly instead.
  const wallMs = Math.max(0, Math.max(...results.map(r => Date.parse(r.at))) - Date.parse(manifest.startedAt));
  const elapsedMs = Math.round(wallMs / manifest.tasks.length);
  const tasks = manifest.tasks.map(mt => {
    const r = byId.get(mt.id);
    return {
      id: mt.id, difficulty: mt.difficulty, category: mt.category,
      passed: r?.passed ?? false,
      promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0,
      totalTokens: Math.round(tokens / manifest.tasks.length),
      turns: 0, costUsd: cost / manifest.tasks.length, costEstimated: true,
      model: modelName, elapsedMs,
      runs: 1, passes: r?.passed ? 1 : 0,
      error: r ? undefined : "no check recorded",
    };
  });

  const solved = tasks.filter(t => t.passed).length;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = join(HERE, "reports", `cursor-${stamp}.json`);
  writeFileSync(outPath, JSON.stringify({
    suite: suite.name, agent: "cursor", model: modelName,
    methodology: "ide-chat single-session; cost from dashboard delta; no token counts",
    when: stamp, complete: true, runs: 1, costEstimated: true,
    solved, total: tasks.length, planned: tasks.length,
    totalCostUsd: cost, totalTokens: tokens, tasks,
  }, null, 2));
  console.log(`Imported ${solved}/${tasks.length} solved, $${cost.toFixed(2)} total → ${outPath}`);
  console.log(`Re-export the website data: bun bench/export-benchmarks-json.ts --min-tasks 33`);
} else {
  console.error("Usage: bun bench/cursor-ide-bench.ts prepare|import [--out dir] [--cost usd]");
  process.exit(1);
}
