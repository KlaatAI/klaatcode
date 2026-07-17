<p align="center">
  <a href="https://klaatai.com">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://klaatai.com/logos/Klaat_white.png" />
      <source media="(prefers-color-scheme: light)" srcset="https://klaatai.com/logos/Klaat_black.png" />
      <img src="https://klaatai.com/logos/Klaat_black.png" width="180" alt="KlaatAI Logo" />
    </picture>
  </a>
</p>

<h1 align="center">Klaat Code</h1>

<p align="center">
  <strong>The terminal-native AI coding agent, powered by Klaatu smart model routing.</strong><br/>
  Claude Code-grade accuracy, at a fraction of the cost — and it's reproducible, not a marketing claim.
</p>

<p align="center">

```bash
npm install -g klaatcode
klaatcode
```

</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License: Apache 2.0" /></a>
  <a href="https://github.com/KlaatAI/klaatcode/actions"><img src="https://github.com/KlaatAI/klaatcode/actions/workflows/klaatcode-ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://www.npmjs.com/package/klaatcode"><img src="https://img.shields.io/npm/v/klaatcode.svg?color=purple" alt="npm version" /></a>
</p>

<p align="center">
  <img src="https://media1.giphy.com/media/v1.Y2lkPTc5MGI3NjExdHh2aHNuMDRwbmdqNnN4ajJrMW9hZnJnbWhzNGw1ZDNiNHQ4NzB2ayZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/gY9xQrCtaMHCmX04FA/giphy.gif" alt="KlaatCode CLI demo" width="720" />
</p>

---

## What is KlaatAI?

**KlaatAI** is an AI platform built around **Klaatu-o1**, a small, fast, agentic router model. Instead of sending every request to one large, expensive model, Klaatu-o1 reads what you're asking, decides which model tier actually needs to handle it, and dispatches accordingly — automatically, per request. Three products sit on top of it: **KlaatAI Web Chat** (browser), **Klaat Code** (this CLI), and the **KlaatAI API** for developers building on the same router directly.

## What is Klaatu?

**Klaatu** is the routing brain — a hosted service, not something that runs on your machine. Every message you send from Klaat Code goes to Klaatu, which classifies it and routes it through one of five cost tiers (`nano → fast → code → reason → heavy`), escalating automatically when a task turns out harder than it looked, and never charging you frontier prices for a trivial turn. Tool calls inside a single request — reads, edits, shell commands, searches — are free; only your messages count against quota. This is also the architectural reason Klaat Code can be open source without giving away the thing that makes it good: **the client is a thin terminal to a service**, the same relationship `gh` has to GitHub. The intelligence — routing decisions, model health tracking, pricing, the code-graph index — lives server-side, at [klaatai.com](https://klaatai.com).

## What is Klaat Code, and how is it different?

Klaat Code is this repo: a terminal-native coding agent you install once and run in any project. It reads your code, edits files, runs commands, and verifies its own work — asking permission before anything risky. Functionally it sits in the same category as **Claude Code**, **opencode**, **Codex CLI**, and **Aider** — same agentic loop, same terminal-first philosophy — but three things are genuinely different:

1. **Smart per-request model routing.** None of the above route per-message to a cost tier the way Klaatu does. You get frontier-level reasoning when a task needs it and pay nano/fast prices for everything else, automatically — not a model you pick once per session.
2. **A real code knowledge graph**, not just grep. Your project is indexed into a call graph with semantic search; the agent queries symbols, callers, callees, and blast-radius instead of reading whole files — typically 5–15× fewer tokens per task.
3. **The comparison is reproducible.** The [benchmark below](#benchmarks) isn't a claim — clone this repo, run `bun run bench`, and verify the numbers yourself against the same fixtures we used.

## Benchmarks

Same 30 fixtures, same prompts, same verify command, run against KlaatCode, Claude Code, opencode, and Grok Build in one harness. Full methodology and honesty notes: [`bench/README.md`](bench/README.md).

| Metric | Klaat Code | Claude Code |
|---|---|---|
| Solved | 30/30 | 30/30 |
| Cost per solved task | **$0.026** | $0.146 |
| Cost ratio | **18%** | (ref) |
| Tokens per solved task | 28% | (ref) |

Equal accuracy, ~5.5× cheaper. Reproduce it:

```bash
git clone https://github.com/KlaatAI/klaatcode.git && cd klaatcode
bun install
bun run bench                              # klaatcode
bun bench/compare-agents.ts --agent claude # or opencode / grok
```

---

## Install

Pick any method — all install a standalone compiled binary (no Node or Bun runtime required at runtime):

**npm (Node ≥ 18 or Bun ≥ 1)**
```bash
npm install -g klaatcode
```
> **macOS `EACCES` error?** Prefix with `sudo`, or fix npm's global prefix once:
> ```bash
> mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global
> echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
> ```

**One-line installer (macOS/Linux)**
```bash
curl -fsSL https://klaatai.com/api/install | bash
```

**Windows (PowerShell)**
```powershell
irm https://klaatai.com/api/install-windows | iex
```

**Homebrew (macOS/Linux)**
```bash
brew install KlaatAI/klaatcode/klaatcode
```

All methods install both `klaatcode` and `klaatai` — identical commands, use whichever you like.

## Quick Start

```bash
klaatcode login                     # browser sign-in — your KlaatAI account, no API keys to manage
klaatcode                           # open current directory
klaatcode ~/projects/my-app         # open a specific project
klaatcode run "Fix all TS errors"   # headless / CI mode
klaatcode whoami                    # check auth
```

---

## Features

### Smart Model Routing

Each request is classified and routed to one of five tiers by Klaatu. You see which tier answered (badge in the header) and why.

```
/tier           # lock a tier, or open the picker
/tier smart     # restore automatic routing
/model          # switch between Klaatu and your own third-party models
/why            # explain the last routing decision
/cost           # session spend + what routing saved you
```

| Tier | Used for |
|---|---|
| `nano` | Trivial turns, completions |
| `fast` | Quick questions, small edits |
| `code` | Default — most coding work |
| `reason` | Debugging, architecture, tricky logic |
| `heavy` | Large refactors, hardest problems |

The router escalates automatically when a task turns out harder than it looked and de-escalates when you don't need the big guns. Tool rounds, retries, and failovers are never billed — one user message = one request.

**Bring your own model.** Don't want Klaatu for a task? Add any OpenAI-compatible endpoint and switch to it per-session:
```
/model add gpt4o https://api.openai.com gpt-4o env:OPENAI_API_KEY
/model gpt4o
```

### Post-Edit Diagnostics — the Model Sees Its Own Mistakes

After a successful edit, Klaat Code runs your project's typechecker/linter on the changed file (auto-detects eslint/biome, ruff, gofmt, or a configured command) and hands any errors straight back to the model in the same turn — it fixes them before returning control to you, instead of costing you a round-trip.

### Terminal UI with Real Syntax Highlighting

Markdown responses render with per-language syntax highlighting directly in the terminal. Code blocks show language labels and are mouse-selectable (drag to auto-copy).

- Streaming responses with live token/cost counter
- Slash-command autocomplete — type `/` for a fuzzy-filtered live suggestion strip
- Collapsible tool output and thinking blocks — click to expand
- Full mouse support: click, scroll, drag-select
- 7 themes: `dark`, `light`, `dracula`, `nord`, `ayu`, `catppuccin`, `gruvbox` (`/theme`)
- Vim keybindings (`/vimmode on`)
- Sidebar: usage, context window fill, MCP servers, routing analytics
- Diffs render as colored, syntax-highlighted unified-diff blocks — including multi-file patches

### Real Plan Mode

Switch to Plan mode (`Tab`) and the model gets only read-only tools — it researches and proposes a plan, you approve, it switches back to Build with the full toolset to implement. No accidental edits while you're just trying to think something through.

### Built-in Tools

| Tool | What it does |
|---|---|
| `read_file` | Read files with line numbers, offset/limit for big files |
| `write_file` | Create/overwrite files (parent dirs auto-created) |
| `edit_file` / `multi_edit` | Surgical string replacement, single or batched atomic |
| `apply_patch` | Multi-file envelope-diff patch — add/update/delete/move, applied atomically |
| `glob` / `grep` / `list_dir` | Find files and search code |
| `run_command` | Execute shell commands (permission-gated) |
| `web_fetch` / `web_search` | Read pages, search the web |
| `todo_write` / `todo_read` | Persistent task list the agent maintains |
| `ask_user` | The agent can ask you a blocking multiple-choice question mid-task |
| `delegate_task` | Spawn a sub-agent for a scoped piece of work, optionally in the background |
| `task_status` | Check on or list background sub-agents |
| `project_graph_query` | Query the code graph: symbols, callers, callees |
| `project_semantic_search` | Meaning-based code search (Pro) |
| `file_outline` | Symbol outline of a file without reading it all |
| `impact_check` | Blast-radius analysis: what breaks if this changes |
| `browser_*` | Navigate, read, and click pages (5 tools) |

### Multi-Agent Workflows

The agent can delegate scoped work to sub-agents with their own context — keeping your main conversation small and cheap. Sub-agent tool rounds are free like all tool calls.

```
> explore the auth and billing modules, then implement token refresh
✻ delegate_task: "map auth module structure" …
✻ delegate_task: "map billing module usage of tokens" …
```

Sub-agents can also run **in the background** (`background: true`): you keep chatting while they work, a `◔ N bg agents` chip tracks them, and results are injected into the conversation when they finish (`task_status` / `/agents` to check in).

### Context Management & Compaction

Long sessions stay affordable without losing the thread:

- **Every request** is mechanically compacted: thinking blocks stripped, stale tool output truncated by usefulness (superseded file reads and consumed search results trimmed hardest), oldest turns dropped last.
- **Compaction budget scales to your active tier's context window** — a session pinned to `nano` compacts harder than one on `heavy`, so requests never overflow the smaller model's window.
- **Automatic summarization** kicks in past the budget: the session is summarized on the cheapest tier into task state, files touched, and decisions, then the conversation continues seamlessly.
- `/compact` triggers it manually; the sidebar shows context-window fill so you're never surprised.
- Code-graph tools mean the agent rarely needs whole files in context in the first place.

### Sessions

Every conversation is saved as a transcript in `~/.klaatai/sessions/`.

```
/sessions       # list saved sessions
/resume <id>    # pick up exactly where you left off
/share          # export session to markdown
```

### Permissions

Three-layer model — safe read-only tools run silently; everything else asks:

- **Allow once / this session / always / deny** prompts, persisted to `~/.klaatai/permissions.json`
- Glob allow/deny lists for shell commands (`rm -rf /`, fork bombs, etc. denied by default)
- Writes sandboxed to the project directory by default; hard-denied system paths (`/etc`, `~/.ssh`, …) refused even with the sandbox off

```json
{
  "allowed_commands": ["git status", "git diff *"],
  "denied_commands":  ["rm -rf /"],
  "trusted_tools": ["read_file", "glob", "grep"]
}
```

### MCP (Model Context Protocol)

Full MCP client, both transports:

- **stdio** — local servers, configured in `.klaatai/mcp.json`, built-in presets (filesystem, GitHub, Postgres, Puppeteer, Brave Search, Fetch, …)
- **Streamable HTTP** — remote servers via `"url"` config or `/mcp add <url>`; SSE and JSON responses, session management, and **OAuth 2.1** (discovery + dynamic client registration + PKCE browser flow) when the server requires auth — tokens cached in `~/.klaatai/mcp-oauth.json`

Manage live with `/mcp`.

### Git Integration

```
/diff           # show git diff
/review         # AI code review of current changes
/commit         # AI-generated commit message + confirm
/undo           # undo last AI file changes
/checkpoint     # snapshot project state
/rollback       # restore a checkpoint
```

### Skills — Reusable Prompt Templates

Save prompts as `.md` files, invoke by name. Project skills in `.klaatai/skills/`, global in `~/.klaatai/skills/`.

```
/skill list
/skill fix-types
/skill new fix-types     # create in $EDITOR
```

### Hooks — Lifecycle Automation

Run shell commands on agent lifecycle events. Hooks receive a JSON payload on stdin (tool name, arguments, result) plus `KLAATAI_*` env vars, can be scoped with a `matcher` regex, and `before_tool` hooks can **block** a tool call (exit code 2, or print `{"decision":"block","reason":"…"}`).

```json
// .klaatai/hooks.json
{
  "after_message": ["afplay /System/Library/Sounds/Glass.aiff"],
  "before_tool": [
    { "matcher": "run_command", "command": "./scripts/guard-shell.sh" }
  ],
  "after_tool":     ["notify-send \"$KLAATAI_TOOL_NAME done\""]
}
```

Events: `before_message` · `after_message` · `before_tool` · `after_tool`

### Project Rules

`.klaatai/rules.md` in your repo is injected into every session — coding standards, architecture notes, dos and don'ts. `/init` auto-generates one from your tech stack. `AGENTS.md` is also respected.

### Plugins

Custom tools as JavaScript modules — `~/.klaatai/plugins/*.js` (global) or `.klaatai/tools/*.js` (project). `/plugin list` · `/plugin reload`.

---

## Full CLI + Command Reference

This README covers the highlights. For every shell flag, slash command, config key, and MCP/hooks/skills detail: **[klaatai.com/docs](https://klaatai.com/docs)**.

## Slash Commands

| Command | Description |
|---|---|
| `/help` | Show all commands |
| `/tier [name]` | Lock a Klaatu routing tier, or open the picker |
| `/model` | Switch between Klaatu and custom third-party models |
| `/why` | Explain last routing decision |
| `/cost` | Session cost + savings |
| `/compact` | Summarize context to free the window |
| `/diff [file]` · `/review [ref]` · `/commit` | Git workflows |
| `/undo` · `/checkpoint [label]` · `/rollback [id]` | Safety nets |
| `/test [args]` | Run tests (auto-detects Bun/Vitest/Jest/pytest/Go/Cargo) |
| `/skill <name>` · `/hooks` | Skills and hooks |
| `/init` | Generate project rules from your stack |
| `/sessions` · `/resume <id>` · `/share` | Session management |
| `/mcp` | Manage MCP servers |
| `/agents` | List agent personas + running background sub-agents |
| `/perms` | Review tool permissions |
| `/theme <name>` · `/vimmode on\|off` | UI |
| `/logout` | Sign out and clear stored credentials |
| `/doctor` | Diagnose auth, API, MCP, project health |
| `/clear` | Clear chat |

Typing `/` shows a live, fuzzy-filtered autocomplete strip for all of the above.

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `ctrl+p` | Command palette |
| `ctrl+r` | Fuzzy history search |
| `ctrl+v` | Attach image from clipboard (screenshots) |
| `ctrl+y` | Copy last AI response |
| `ctrl+b` | Collapse/expand thinking blocks |
| `ctrl+d` | Quit |
| `ctrl+c` / `esc` | Cancel streaming |
| `ctrl+x ctrl+e` | Compose message in `$EDITOR` |
| `@` | Fuzzy file picker — inserts file reference |
| `!cmd` | Run shell command, inject output |
| `Tab` | Switch Build / Plan mode |
| Mouse drag | Select + auto-copy |

<details>
<summary><b>Vim mode</b> (<code>/vimmode on</code>)</summary>

| Key | Action |
|---|---|
| `esc` | NORMAL mode |
| `i / a / A / I` | INSERT mode |
| `h / l` | Move cursor |
| `j / k` | Scroll chat |
| `w / b / e` | Word motion |
| `0 / $` | Line start / end |
| `dd` / `D` | Clear input / kill to EOL |
| `gg / G` | Top / bottom |
| `ctrl+u / ctrl+d` | Half-page scroll |

</details>

---

## Headless / CI Mode

```bash
klaatcode run "Summarise CHANGELOG.md"                 # streams to stdout
echo "Explain this function" | klaatcode run -          # pipe input
klaatcode run "Fix type errors" --model fast            # with options
klaatcode run "Security-check auth.ts" < auth.ts        # in CI
```

```yaml
# GitHub Actions
- name: Fix lint errors
  env:
    KLAATAI_API_KEY: ${{ secrets.KLAATAI_API_KEY }}
  run: klaatcode run --model code "Fix all ESLint errors and commit"
```

## API Server Mode

```bash
klaatcode serve --port 4200
```

- `GET  /v1/health` — health check
- `GET  /v1/info` — session info
- `POST /v1/chat` — chat with SSE streaming
- `POST /v1/run` — single prompt → SSE stream

`klaatcode web` serves a browser UI on top of the same server.

## Configuration

`~/.klaatai/config.json`:

```json
{
  "baseUrl": "https://api.klaatai.com",
  "routingDisplay": "minimal",
  "theme": "dark",
  "vimMode": false
}
```

| Key | Values | Description |
|---|---|---|
| `routingDisplay` | `off` / `minimal` / `full` | Routing detail in chat header |
| `theme` | see theme list above | UI theme |
| `vimMode` | `true` / `false` | Vim keybindings |
| `sandbox` | `project` / `off` | Write sandbox scope |
| `diagnostics` | `on` / `off` | Post-edit typecheck/lint feedback loop |
| `customModels` | array | Third-party OpenAI-compatible models (see `/model add`) |

Full reference, incl. every config key: [klaatai.com/docs/configuration](https://klaatai.com/docs/configuration).

## Directory Structure

```
~/.klaatai/
  credentials.json    # auth tokens (never committed, never shared)
  config.json         # user preferences
  permissions.json    # tool permission rules
  mcp.json            # global MCP servers
  mcp-oauth.json      # cached OAuth tokens for remote MCP servers
  hooks.json          # global lifecycle hooks
  sessions/           # saved session transcripts
  skills/             # global prompt skills (.md)
  plugins/            # custom tool plugins (.js)
  todos.json          # persistent todo list

.klaatai/             # project-level (in your repo)
  rules.md            # project rules (injected every session)
  mcp.json            # project MCP servers
  hooks.json          # project lifecycle hooks
  skills/             # project prompt skills
  tools/              # project tool plugins (.js)
```

## How Authentication Works

Sign-in is browser-based OAuth against your KlaatAI account — there are no API keys to generate or paste. `klaatcode login` opens a browser tab, you authenticate with KlaatAI, and a short-lived JWT plus refresh token are stored locally in `~/.klaatai/credentials.json` (mode `0600`, never synced or logged). The CLI silently refreshes the token in the background and recovers automatically from expiry mid-session; `klaatcode logout` clears everything. Every chat request goes straight to Klaatu over HTTPS with that token — the server enforces your plan's quota and never proxies your credentials anywhere else.

## Contributing

We welcome contributions — see [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup, the PR process, and what `bun run bench:selfcheck` needs to pass before a PR is reviewed.

## Security

Found a vulnerability? Please don't open a public issue — see [SECURITY.md](SECURITY.md) for how to report it responsibly.

## Roadmap

- LSP tool (go-to-definition, find-references, rename) alongside the existing code graph
- Git worktree isolation for parallel/risky sub-agent work
- Published SWE-bench Verified scores
- Team-shared code graph, `klaat org` commands

## Star History

<a href="https://star-history.com/#KlaatAI/klaatcode&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=KlaatAI/klaatcode&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=KlaatAI/klaatcode&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=KlaatAI/klaatcode&type=Date" width="600" />
 </picture>
</a>

## License

Apache License 2.0 © KlaatAI — see [LICENSE](LICENSE).

The **KlaatAI**, **Klaat Code**, and **Klaatu** names and logos are trademarks of KlaatAI and are not covered by this license — see [LICENSE](LICENSE) for the trademark notice.
