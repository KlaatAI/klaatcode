# KlaatCode Benchmark Harness (Phase 7)

Objective cost / tokens / success measurement per solved task. This is the
number that answers "are we actually cheaper *and* accurate vs Claude Code?"

## How it works

For each task in `suite.json`:

1. Copy the fixture dir to a fresh temp workspace (never touches the fixture).
2. Run the headless agent (`src/agent/headless-agent.ts`) — the REPL's real
   tool loop, no TUI, no permission prompts, sandboxed to the workspace.
3. Run the verify command (default `bun test`) in the workspace. Exit 0 = solved.
4. Record: solved?, cost (USD est), tokens, requests, turns, tool calls,
   tiers used, wall-clock.

Output: a table to stdout + `bench/reports/<timestamp>.json` — the artifact you
diff across runs, tiers, and against Claude Code's own numbers.

## Run

```bash
bun run bench                     # whole suite, auto-route
bun run bench -- --tier code      # pin a tier
bun run bench -- --only fix-fizzbuzz
bun run bench -- --runs 3         # repeat each task, report pass-rate
bun run bench -- --from implement-lru-cache   # resume mid-suite (quota abort)
bun run bench -- --category bugfix            # one category only
```

Needs auth: `klaatai login` first, or `KLAATAI_API_KEY=...`.

The report JSON is written incrementally after every task — a mid-suite abort
(daily quota, ctrl-c) still leaves a usable partial report (`"complete": false`).

## Tasks (33)

Each task is a self-contained fixture dir with failing tests the agent must make
pass **without editing the test file**. Categories:

| category | count | what it exercises |
|----------|-------|-------------------|
| `bugfix` | 11 | find + fix a planted bug (off-by-one, mutation, async ordering, float money, regex escaping, unicode, shallow copy, state machine, …) |
| `implement` | 13 | implement a function/class from a stub + spec comment (LRU cache, event emitter, query string, JSON pointer, expression evaluator, …) |
| `multi-file` | 3 | the failing test is not where the fix is — cross-file navigation (implement imported module, bug in dependency, missing export) |
| `refactor` | 1 | behavior-preserving API change (callback → Promise) |
| `long-context` | 5 | large ~30-file fixtures where navigation is the task: cross-module bug hunts, a wide mechanical fix across 8 feature modules, stale cache keys, wrong metric arguments, config precedence — exercises code-graph/search efficiency |

Difficulty spread: 10 easy · 18 medium · 5 hard.

## Suite integrity — selfcheck (run after any task change)

```bash
bun run bench:selfcheck    # no agent, no tokens, fully local
```

For every task it verifies: (1) the fixture FAILS as shipped, and (2) it PASSES
with the reference solution from `bench/solutions/<id>/` overlaid. Both must
hold or the task is broken. CI-safe.

## Add a task

1. `mkdir bench/tasks/<id>/src`, add source + a `*.test.ts` that fails.
2. Add the reference solution under `bench/solutions/<id>/src/` (same relative
   paths — it is overlaid on the fixture).
3. Add an entry to `suite.json` (`id`, `dir`, `prompt`, `difficulty`, `category`).
4. `bun run bench:selfcheck` — must report ✓ for your task.

## Comparing against other agents

`compare-agents.ts` runs the identical suite through competing CLIs — same
fixtures, same prompts, same verify command; the only variable is the agent:

```bash
bun bench/compare-agents.ts --agent claude   --model claude-sonnet-5
bun bench/compare-agents.ts --agent opencode --model opencode/nemotron-3-ultra-free
bun bench/compare-agents.ts --agent grok
bun bench/compare-agents.ts --agent cursor   # needs cursor-agent CLI + login
bun bench/compare-agents.ts --agent <a> --from <task-id>   # resume after abort
```

Honesty rules baked into the harness: promo-free models are priced at their
published paid rates; subscription CLIs that report no dollars get token-based
estimates marked `~`; rate-limited tasks are marked invalid samples (rerun
later with `--from`), never counted as failures.

### Cursor IDE-chat lane

When `cursor-agent` (headless CLI) is unusable, `cursor-ide-bench.ts` runs the
lane through the Cursor IDE's own agent chat: `prepare` builds a workspace of
all 33 tasks plus a paste-prompt and an objective `run-check.sh` referee;
`import --cost <usd> --tokens <n>` converts the results (cost/tokens from the
Cursor dashboard's on-demand usage delta) into a normal report JSON, tagged
with its single-session methodology.

Latest results table + interactive per-task drill-down:
[klaatai.com/benchmarks](https://klaatai.com/benchmarks) (regenerated from
`bench/reports/` via `bun bench/export-benchmarks-json.ts`).
