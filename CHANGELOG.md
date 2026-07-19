# Changelog

All notable changes to Klaat Code are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

Six features no other CLI coding agent ships built-in — token efficiency and runaway-protection, all on by default, all with an `off` switch.

### Added

- **Tool-output noise filter** (`outputFilter`). 60–75% of command-output tokens are noise you pay for on every later request. Progress bars now collapse to their final frame, long runs of passing tests collapse to a count (`[✓ 40 passing tests — collapsed]`), repeated lines dedupe, ANSI codes and carriage-return spinner frames are cleaned up. Failures, exit codes, and summary lines are always kept in full, and the filter fails open — any doubt, you get raw output.
- **`plan_exploration` tool — a query optimizer for code.** Before reading anything, the agent can ask for the optimal file-read order for a task: files you named (full read), files defining matched symbols (targeted section at the right line), and their callers (outline only). Derived from the local code graph; the system prompt tells the agent to use it first on any multi-file task. No other CLI plans its reads.
- **Attention-ordered context** (`attentionOrder`). Models attend most strongly to the start and end of their context window ("lost in the middle"). Older history is now arranged so the highest-relevance turns sit at the context edges and exploration noise is buried in the middle. Tool-call/result pairs never split; recent turns and the system prompt never move.
- **Budget guards.** Real-time burn-rate tracking with a warning when spend runs 3× your session average; per-task cost attribution and a phase breakdown in `/cost`; an optional hard session cap (`maxSessionCost`) that pauses agent rounds instead of burning on; `klaatcode run --max-cost <usd>` for CI and cron (exit code 3). No other CLI monitors spend *rate*.
- **Per-phase token budgets** (`phaseBudgets`). The classic stuck-agent failure — the whole budget burned exploring before a single line is written — is now caught directly: tokens are attributed to explore/implement/verify phases, and exploration that exhausts its budget without producing an edit pauses and asks instead of continuing.
- **Context-collapse detection.** Compaction is lossy and normally silent. Klaat Code now snapshots the critical state (your task in your own words + the files being modified) to the session ledger *before* compacting, mechanically verifies the summary still covers it *after*, and — when something was lost — injects a recovery note telling the model exactly what it forgot and where to re-read it. First CLI that can tell you it forgot something.
- **`/context` command.** See what's actually in the model's window (message counts, token estimate, degraded tool results) vs. what's been compacted away, plus the ledger path where compacted details stay recoverable.
- **Server doom-loop reaction.** Klaatu detects when the agent repeats the same tool call with identical arguments and identical results; the CLI now refuses that round, injects recovery guidance ("change approach — don't repeat the call"), and stops entirely after three refusals. Works in the TUI and headless runs. Pairs with the existing no-tool-call-limit design: unlimited productive loops, zero tolerance for stuck ones.
- **Server retry contract honored.** `X-KlaatAI-Retry: no` (the server's failover cascade already exhausted every fallback) is never blindly retried; `after-<s>` schedules exactly one retry; waits over 60 s surface as errors instead of hanging your terminal.

- **Benchmark refresh — 33-task suite, 5 agent lanes** (2026-07-19). Suite grown to 33 tasks (5 long-context). New adapters: Claude Code on Sonnet 5, opencode on Nemotron 3 Ultra (promo-free tokens priced at published paid rates), Cursor (`cursor-agent`, plus a `cursor-ide-bench.ts` IDE-chat lane with an objective check-script referee for when the headless CLI is unusable). Results: Klaat Code 33/33 at $0.027/solve — 5.4× cheaper than Claude Code, 1.8× cheaper than the nearest competitor. Interactive per-task comparison: [klaatai.com/benchmarks](https://klaatai.com/benchmarks).

### Notes

- All new behaviors are on by default. Opt out per feature in `~/.klaatai/config.json`: `outputFilter`, `attentionOrder`, `phaseBudgets` (`"off"`), `maxSessionCost` (unset).
- New docs: [Configuration](https://klaatai.com/docs/configuration), [Commands](https://klaatai.com/docs/commands), [CLI reference](https://klaatai.com/docs/cli-reference).

## [2.2.3] and earlier

Pre-changelog era: smart per-request tier routing, code knowledge graph (`impact_check`, semantic search), 28-tool agentic loop, tier-aware toolset dialects, fuzzy 9-pass edit engine, `apply_patch`, real plan mode, background sub-agents, MCP (stdio + HTTP + OAuth), hooks v2, skills v2, plugins, retention-aware compaction + session ledger, sessions/resume, write sandbox, post-edit diagnostics, published 4-way benchmark (equal accuracy at 18% of Claude Code's cost). See the [README](README.md) and git history.
