# Changelog

All notable changes to Klaat Code are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Added (quick wins from competitor research)

- **Cost receipt on every turn** — the end-of-turn summary now carries the money: `Read 3 files · 2 edits · ran 2 commands · $0.033 · saved $0.29 vs frontier · 34s` (frontier baseline = titan rates on the same tokens). `/cost` gains a "Last turn (receipt)" block: cost, per-tier request mix, tokens in/out (+cached), duration. Pinning a premium tier (`/tier reason|heavy|titan`) shows an honest pre-flight estimate before the turn runs; auto-routed turns are never estimated (the server picks the tier per request, so a number would be a guess).
- **Side-channel accounting** — `/btw` and `/advisor` responses now register in session accounting: request count, per-tier tally, `/why` metadata (served model/tier), quota snapshot, and cost computed from the tier the server actually served (was hardcoded to the requested tier). Previously they were invisible — sidebar showed zero requests and `/why` said "No request made yet" after a successful consult.
- **`/advisor` heavy-tier timeout fix** — heavy responses are still server-buffered until the A2 deploy, so the consult now uses a 120s response-header timeout (`connectTimeoutMs` option on `chatStream`) instead of the 45s default that made it fail with "Timed out waiting for the model".
- **`/advisor` (Oracle-style consult)** — one command escalates to the heavy tier for a senior-engineer review of the current approach: it reads a condensed transcript, streams sharp guidance into an `⚖ advisor` block, and feeds the advice back into the conversation so the main agent applies it next turn. `/advisor <specific question>` to direct it.
- **`/security-review`** — security-focused preset over `/review` (injection, authz, secrets, SSRF, deserialization, traversal, XSS, races, dependency risk).
- **`/add-dir <path>`** — session-scoped extra working directory: extends the write sandbox and informs the agent.
- **`/btw` side channel** — ask a quick side question any time, even mid-turn: answered immediately on the fast tier in its own `↷ btw` transcript block, streaming live. The main conversation, its context, and the running turn are completely untouched (nothing enters `apiMessages`).
- **Type while the agent works (steering + queue)** — input stays live during a turn; Enter queues the message, and non-slash messages are injected into the running turn at the next round boundary so the model course-corrects mid-task (Claude Code-style). Slash commands and leftovers run in order after the turn. Queued items show as `↳ queued` chips; Esc interrupt clears the queue.
- **/review presets** — `/review` (uncommitted), `/review base <branch>` (branch vs merge-base), `/review commit <sha>`, `/review <ref|range>`, or `/review <free text>` as a custom focus. Findings ordered by severity.
- **Terminal notifications** — OSC9 + bell when a >15s turn finishes or the agent needs approval, so you can tab away. `notifications: "off"` in config disables.
- **Layered AGENTS.md discovery** — global `~/.klaatai/AGENTS.md`, then git root → cwd chain (per-dir first match of `.klaatai/rules.md` → `AGENTS.md` → `CLAUDE.md`), concatenated root-first with closer files winning, capped at 32KiB. Matches the emerging industry semantics.
- **Durable command rules on "always allow"** — approving a command with "always" now stores a two-token prefix rule per chained sub-command (`bun test *`, `git push *`) instead of the exact string, so the next variation doesn't re-prompt.

### Security

- **`/review` argument injection closed** — ref arguments are validated (no leading `-`, ref-safe charset) before reaching git argv; flag-like or multi-word input is treated as a review focus and never touches git (blocks e.g. `/review --output=<file>`).
- **Terminal notification sanitization** — OSC9 payloads strip C0/C1 control characters and DEL, so no message content can smuggle further escape sequences.
- **Shell-chain permission bypass fixed** — allowlist patterns like `cat *` previously glob-matched the whole command string, so `cat x; sudo rm -rf /` auto-passed. Commands are now split on `&&`/`||`/`;`/`|` (quote-aware) and every sub-command must pass the allowlist on its own; commands with redirects/substitution/backgrounding are opaque and only match exact allowlist entries. Deny list checks both the whole string and each sub-command. Covered by new `src/permissions/index.test.ts`.

### Fixed

- **TUI froze during long shell commands** — foreground `run_command` (and `grep`) used `spawnSync`, which blocks the entire event loop: no spinner, no rendering, no Esc until the command finished (up to its timeout). Both now run async with a 10MB output cap; the UI stays live and animated throughout.
- **Esc now actually stops running commands** — interrupt kills the whole process group (not just `sh`, whose orphaned children previously kept the pipe open and the round hung until their natural exit). Kill latency measured ~300ms; the tool result is marked `[killed …]` so the model knows.
- **Auth refresh can no longer hang or force needless re-login at boot** — the Supabase refresh call now has an 8s timeout, and a *network* failure (offline/slow) falls back to the stored access token instead of returning null and triggering browser OAuth; only a genuinely rejected refresh token (4xx) demands re-login. The 401 recovery path retries once online.

### Changed

- **Instant startup** — boot no longer blocks on a network ping gate (up to ~27s on flaky networks) or artificial splash delays (~1.5s of `sleep`s on every launch). The REPL opens immediately after credential load; connectivity is probed in the background and surfaces as a status-bar badge (`· connecting…` / `⚠ offline — retrying`, auto-retry every 10s).

### Added

- **Live tool group** — running tool calls now appear in the transcript the moment they start, as one Claude Code-style aggregate line with a pulsating dot ("● Reading 1 file, running 2 shell commands…") and a ⎿ detail line per call. Calls leave the group and become normal ⏺ result rows as each one finishes.
- **Claude-style busy status line** — the input-area status now shows the real activity ("Reading 1 file, running 2 shell commands… (1m 40s · ↓ 6.2k tokens) · esc to interrupt") instead of a bare whimsy verb; the redundant footer "esc interrupt" line is merged into it. `grep` now skips node_modules/.git/dist/lockfiles/tsbuildinfo by default.
- **Session counters survive resume** — a cumulative usage snapshot (requests, tokens, cost) is appended to the session file each turn; resuming restores the sidebar Session block instead of showing zeros.
- **Turn activity summary** — after a multi-tool turn, one dim line tallies the work: `Read 3 files · 2 edits · ran 2 commands · 34s`.
- **Background shell badge** — the status bar now shows running background shells (`⚙ N bg shells`) alongside the existing bg-agent badge, with an animated spinner while any background work is live.
- **Path-guessing guard** — "File not found" errors from read/edit tools now include a listing of the nearest existing directory plus an explicit "do not guess" instruction, and the system prompt forbids reading paths never seen in a listing/search result (kills the observed loop of models inventing conventional paths like `src/app/dashboard/page.tsx` and retrying variations). MCP tools that overlap with built-ins are now explicitly deprioritized in the prompt.
- **Context meter survives resume** — after `/resume` (or `klaatcode -r`) the context gauge shows an estimate of the restored transcript instead of 0; the server's real count replaces it on the first request. MCP tool names render as `mcp:server tool` instead of `Mcp__server__tool`.
- **Session self-awareness** — the agent now knows who is logged in (account email, backend URL, CLI version, from the Environment block) and answers "what account am I connected to?"-style questions directly instead of exploring the project's .env/config files. New `/whoami` slash command shows account, plan, backend, version, and connectivity.

## [2.3.5] — 2026-07-30

### Fixed

- **Windows `klaatcode upgrade`** — PowerShell/curl installs no longer try to replace `klaatcode.exe` while it is running (the cause of silent `Upgrade command failed` on v2.3.2–2.3.4). Upgrade now spawns a detached helper that waits for the current process to exit, then runs the install script. npm global upgrades run through `cmd.exe` (bare `spawnSync("npm")` fails on Windows). Also detects `.bun` global installs.
- **CI unit tests** — `acp/agent.test.ts` mock no longer breaks `chatStream` socket-drop tests in `api/client.test.ts`.

## [2.3.4] — 2026-07-30

### Fixed

- **Session resume freeze after first message** — `klaatcode -r` could lock up after the first reply (no typing, scroll, or Ctrl+C). The pre-boot session picker left a stdin listener attached; the first Enter in the TUI re-ran cleanup and disabled raw mode. The picker now detaches cleanly on exit.
- **Resume forked a duplicate session** — continuing a resumed chat wrote a new `.jsonl` instead of appending to the original. Resume now keeps the original session id/file and restores server session affinity.
- **Permission card Esc was a no-op** — Esc advertised as “deny” did nothing while the card was up (specific Escape handler blocked the catch-all). Esc now denies / dismisses permission and budget-pause cards.
- **Mid-stream socket drops** — Bun’s “socket connection was closed unexpectedly” no longer kills the turn with a raw error; partial output is kept when possible, and connect waits have a headers-only timeout.

### Changed

- **Faster `-r` / `/sessions`** — session previews stop at the first user message instead of parsing entire transcripts (large sessions no longer stall startup).

## [2.3.3] — 2026-07-29

### Changed

- **Tier picker UX** — wider professional layout, aligned descriptions that no longer bleed past the border, current tier marked with ✓ and focused on open, clickable rows (mouse select), and a clickable **← Back** footer (Esc still cancels).

## [2.3.2] — 2026-07-29

### Added

- **Titan tier (`/tier titan`)** — Klaatu's new top tier, Kimi K3 (2.5T params), is now selectable from the CLI: `/tier titan`, the `/tier` picker, `--model titan` on `klaatai run`, and shell completions. Previously the client rejected it as an invalid tier.
- **Correct cost and context for titan turns** — the cost receipt, `/cost`, `/stats`, the context meter, and compaction now use titan's real price ($7.50 in / $37.50 out per MTok) and 220K window instead of falling back to code-tier numbers.
- **Session lifecycle hooks** — `session_start` and `session_end` events in `.klaatai/hooks.json`, firing exactly once per session.
- **MCP config import** — auto-import MCP servers from `.mcp.json`, `.claude.json`, and `.cursor/mcp.json`.

### Notes

- Titan is **never auto-routed** — the router will not escalate you into it; you ask for it by name. It is a Pro-and-above tier, capped per day, and de-escalates to `heavy` once the cap is spent (Starter gets it only during a promo window). Sub-agents (`delegate_task`) deliberately cannot select titan, so a delegated turn can't spend your daily allowance.

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
