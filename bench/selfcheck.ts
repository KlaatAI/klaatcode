/**
 * Suite integrity check — no agent, no tokens, fully local.
 *
 * For every task in suite.json:
 *   1. Copy the fixture to a temp dir and run its verify command —
 *      it must FAIL (a fixture that passes as shipped is not a real task).
 *   2. Overlay the reference solution from bench/solutions/<id>/ and run
 *      verify again — it must PASS (proves the task is actually solvable
 *      and the tests match the spec).
 *
 * Run: bun bench/selfcheck.ts   (also: bun run bench:selfcheck)
 * Exit 1 if any task is broken. Run this after adding or editing a task.
 */

import { cp, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));

interface Task { id: string; dir: string; verify?: string }
interface Suite { name: string; verify: string; solutionsDir?: string; tasks: Task[] }

const exists = (p: string) => stat(p).then(() => true, () => false);

function verifyPasses(dir: string, cmd: string): boolean {
  const [c, ...args] = cmd.split(" ");
  return spawnSync(c!, args, { cwd: dir, encoding: "utf-8", timeout: 60_000 }).status === 0;
}

const suite = JSON.parse(await readFile(resolve(HERE, process.env.BENCH_SUITE ?? "suite.json"), "utf-8")) as Suite;
console.log(`\n  ${suite.name} — checking ${suite.tasks.length} task(s)\n`);

let broken = 0;
for (const task of suite.tasks) {
  const fixture = resolve(HERE, task.dir);
  const solution = resolve(HERE, suite.solutionsDir ?? "solutions", task.id);
  const cmd = task.verify ?? suite.verify;
  const problems: string[] = [];

  const work = await mkdtemp(join(tmpdir(), `klbench-check-${task.id}-`));
  try {
    await cp(fixture, work, { recursive: true });
    if (verifyPasses(work, cmd)) problems.push("fixture PASSES as shipped (must fail)");
    if (!(await exists(solution))) {
      problems.push("no reference solution in bench/solutions/");
    } else {
      await cp(solution, work, { recursive: true });
      if (!verifyPasses(work, cmd)) problems.push("reference solution FAILS verify");
    }
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }

  if (problems.length) {
    broken++;
    console.log(`  ✖ ${task.id}: ${problems.join("; ")}`);
  } else {
    console.log(`  ✓ ${task.id}`);
  }
}

console.log(broken
  ? `\n  ${broken} task(s) broken\n`
  : `\n  All ${suite.tasks.length} fixtures verified: fail as shipped, pass with reference solution.\n`);
process.exit(broken ? 1 : 0);
