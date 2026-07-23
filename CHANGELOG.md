# Changelog

All notable changes to Klaat Code are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [2.3.0] — 2026-07-23

### Added

- **Prompt-cache savings in the sidebar** — the Context panel now shows `Cached N (X% of input)` when the server's prompt cache is hitting, so you can see the cost saving in real time.
- **Honest context meter** — the Context panel shows the active model's real window (not a misleading sum of all tiers), a `Compact at %` indicator, and cumulative `Processed` tokens since the last compaction.

### Changed

- **Cleaner tool-call display** — reads, edits, and commands now render as a single tidy line (Claude-style), colour-coded by status (green ok / red fail), and expand on demand. No more three-line content dumps cluttering the transcript.
- **Window-aware compaction** — context compaction now triggers at ~78% of the *active* model's window instead of a fixed 60K threshold, so it works correctly on every tier — including small ones where it previously never fired.
- **Tier context windows aligned with the server** — removes a double-trim that could shrink your working context more than intended.

### Fixed

- **Context no longer pins at 100% / stalls** — compaction reliably frees space as context fills, on every tier (the old threshold was larger than the small-tier window, so it never ran).
- **"Continue" no longer loops** — after an exploration-budget pause, continuing no longer re-reads the same files and hits the identical wall; the agent gets more room plus a directive to act on what it already has.
- **No false "agent may be stuck" pauses on analysis** — deep read/analysis tasks (e.g. comparing large datasets) are no longer stopped mid-way. The pause now fires only on a genuine repetition loop, and producing a real answer counts as progress.
- **MCP file writes now tracked** — files written via MCP filesystem tools appear in **Modified Files** and support `/undo` (previously showed "Modified Files 0" despite successful writes).

### Notes

- Several routing improvements ship **server-side** and roll out automatically (no CLI update needed): heavy / multi-file conversations auto-escalate to a larger-window model so builds don't stall; mechanical build steps (writing files, running commands) use the faster code tier instead of the slower reasoning tier; large prompts prefer cache-capable models to cut cost.

## [2.2.9] — 2026-07-21

### Fixed

- **Windows browser auto-open** — Now tries 3 methods in sequence: `explorer.exe` (most reliable, no shell interpretation), `powershell.exe Start-Process`, and `rundll32 url.dll` as final fallback. Covers machines where PowerShell is blocked or not in PATH.
- **URL not copyable in TUI** — When browser fails to open, the auth URL is now **auto-copied to clipboard** (`clip` on Windows, `pbcopy` on macOS, `xclip` on Linux). User sees "URL copied to clipboard — paste in browser" instead of trying to select text from the TUI alt-screen.

## [2.2.8] — 2026-07-21

### Fixed

- **Version display** — Splash screen now shows "KlaatCode v2.2.8" instead of hardcoded "CLI v0.1.0".
- **Fallback URL overflow** — When browser fails to auto-open, the auth URL no longer bleeds into other UI components. Long URLs are now wrapped to fit the terminal width.
- **Fallback URL visibility** — Auth URL displayed in blue underlined text, auto-detected as clickable by modern terminals (Windows Terminal, iTerm2, VS Code terminal).

## [2.2.7] — 2026-07-21

### Fixed

- **Windows login STILL broken — `cmd.exe` truncates URL at `&` even via `spawn`.** The v2.2.5 fix used `spawn("cmd.exe", ["/c", "start", "", url])` but cmd.exe processes `&` as a command separator regardless of how it's invoked. Switched to `powershell.exe Start-Process` which correctly handles URLs containing `&`, `=`, and other special characters without interpretation. Windows users will now see the full auth page with all parameters intact.

## [2.2.6] — 2026-07-21

### Fixed

- **Windows (and all new installs) pointed at localhost instead of production API.** The default `baseUrl` in `DEFAULT_CONFIG` was `http://127.0.0.1:8765` (the local dev server). Fresh installs with no `~/.klaatai/config.json` would open the browser to `http://localhost:4410/klaatu/cli-auth` — which doesn't exist on user machines. Default is now `https://api.klaatai.com`, so login correctly opens `https://klaatai.com/klaatu/cli-auth`. Existing installs with a config file are unaffected.

### Added

- **Claude Code skills compatibility** — `.claude/skills` directory is now auto-discovered alongside `.klaatai/skills`. Thanks [@syf2211](https://github.com/syf2211)! ([#43](https://github.com/KlaatAI/klaatcode/pull/43))
- **`/export` slash command** — export the current session to a Markdown file. Thanks [@Ayush7614](https://github.com/Ayush7614)! ([#45](https://github.com/KlaatAI/klaatcode/pull/45))
- **Swift, PHP, Kotlin, Shell post-edit diagnostics** — the feedback loop now runs `swiftc`, `php -l`, `kotlinc`, and `shellcheck` when available. Thanks [@Ayush7614](https://github.com/Ayush7614)! ([#44](https://github.com/KlaatAI/klaatcode/pull/44))

## [2.2.5] — 2026-07-21

### Fixed

- **Windows login broken — browser auth now works on Windows.** Three issues combined to break the OAuth redirect on Windows: (1) `cmd.exe`'s `start` command misinterpreted `&` in the login URL as a command separator, truncating query params — fixed by using `spawn` with an explicit arg array that bypasses shell interpretation; (2) the local callback server bound only to `127.0.0.1` which some Windows firewall configs block — now binds to `0.0.0.0` on Windows; (3) the redirect URI used `127.0.0.1` which some browsers resolve to IPv6 `[::1]` — now uses `localhost` on Windows for correct resolution. ([#47](https://github.com/KlaatAI/klaatcode/issues/47))

### Added

- **Shell completions (bash / zsh / fish).** `klaatcode completions bash|zsh|fish` prints a static completion script — works in the compiled binary without reading from disk. Covers both `klaatcode` and `klaatai` binary names. Thanks [@Ayush7614](https://github.com/Ayush7614)! ([#46](https://github.com/KlaatAI/klaatcode/pull/46))

### Changed

- **`pull-from-public.sh`** now recommends `patch -p1` instead of `git apply` (which silently skips patches in monorepo layouts).
- **Fallback URL display** — if the browser doesn't open on any platform, the full login URL is printed to the terminal after 2 seconds so users can copy-paste manually.

## [2.2.4] — 2026-07-20

Six features no other CLI coding agent ships built-in — token efficiency and runaway-protection, all on by default, all with an `off` switch. Plus the first two community contributions.

### Community

- **Tokyo Night theme** (`/theme tokyo-night`) — deep navy with cool blue & green accents. Thanks [@floze-the-genius](https://github.com/floze-the-genius)! ([#40](https://github.com/KlaatAI/klaatcode/pull/40))
- **Ruby diagnostics** — post-edit feedback loop now runs `rubocop` on `.rb` files when it's on PATH. Thanks [@siddhanttiwari19](https://github.com/siddhanttiwari19)! ([#41](https://github.com/KlaatAI/klaatcode/pull/41))

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

- **Benchmark refresh — 33-task suite, model-variant lanes** (2026-07-20). Suite grown to 33 tasks (5 long-context). New adapters: Claude Code on Sonnet 5, opencode on Nemotron 3 Ultra (promo-free tokens priced at published paid rates), and Cursor via both Composer 2.5 variants (`cursor-agent`, plus a `cursor-ide-bench.ts` IDE-chat lane with an objective check-script referee for when the headless CLI is unusable). Results: Klaat Code 33/33 at $0.027/solve and 23s median/task — 5.4× cheaper than Claude Code, 1.7× cheaper than the nearest rival, and no rival is both cheap and fast (Composer 2.5 standard: within 1.7× on cost but ~113s/task). Interactive cost curves + per-task comparison: [klaatai.com/benchmarks](https://klaatai.com/benchmarks).

### Fixed

- **Installer channels served the retired 1.x line.** `klaatai.com/api/latest` and the curl installer's npm fallback pointed at the old `klaatcode-ai` package — when the GitHub API was unreachable they reported/installed `1.15.x` instead of the current CLI. Both now resolve the `klaatcode` package. The Windows installer also stopped requesting the discontinued `windows-arm64` asset (Windows-on-ARM uses the x64 binary via built-in emulation).

### Notes

- All new behaviors are on by default. Opt out per feature in `~/.klaatai/config.json`: `outputFilter`, `attentionOrder`, `phaseBudgets` (`"off"`), `maxSessionCost` (unset).
- New docs: [Configuration](https://klaatai.com/docs/configuration), [Commands](https://klaatai.com/docs/commands), [CLI reference](https://klaatai.com/docs/cli-reference).

## [2.2.3] and earlier

Pre-changelog era: smart per-request tier routing, code knowledge graph (`impact_check`, semantic search), 28-tool agentic loop, tier-aware toolset dialects, fuzzy 9-pass edit engine, `apply_patch`, real plan mode, background sub-agents, MCP (stdio + HTTP + OAuth), hooks v2, skills v2, plugins, retention-aware compaction + session ledger, sessions/resume, write sandbox, post-edit diagnostics, published 4-way benchmark (equal accuracy at 18% of Claude Code's cost). See the [README](README.md) and git history.
