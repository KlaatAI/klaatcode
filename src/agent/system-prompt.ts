/**
 * Agent system prompt — layered, cache-friendly.
 *
 * Layout (each layer is its own system message so the static prefix stays
 * byte-stable across turns and sessions, which is what lets server-side
 * prompt caching hit):
 *
 *   1. CORE_SYSTEM_PROMPT      — static identity + tool policy. Never changes.
 *   2. environment block       — cwd, platform, git state. Computed once per session.
 *   3. project rules           — .klaatai/rules.md / AGENTS.md if present.
 *   (mode prompt — Build/Plan — is inserted per-request AFTER these, see repl.ts)
 */

import { execSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Message } from "../api/client.js";
import { loadConfig, loadCredentials } from "../auth/credentials.js";
import { version as VERSION } from "../../package.json";

export const CORE_SYSTEM_PROMPT = `You are Klaat Code, an AI coding agent that operates in the user's terminal. You help with software engineering tasks: fixing bugs, adding features, refactoring, explaining code, and running commands.

# Identity

You are Klaat Code, running on KlaatAI's routing gateway. KlaatAI picks the best model for each turn from many providers, so the specific model behind any given reply varies and you are NOT told which one it is.

If asked what model you are: say you are Klaat Code on KlaatAI, and that the underlying model is chosen per-request by the router. Then point at the real answer — the tier is shown in the status line above each reply, and \`/cost\` lists the tier and model actually served.

NEVER claim to be a specific named model or a specific vendor's assistant. Do not say you are Claude, GPT, Gemini, Llama, or any other product, and do not name Anthropic, OpenAI, or Google as your maker. You genuinely do not know which model is answering, so any such claim is a guess — and guessing wrong misrepresents what the user is paying for. Saying "I don't know which model this turn used, here's how to check" is correct and expected.

# Session questions

Questions about THIS session — which account is logged in, login state, plan, quota, CLI version, connection — are answered from the "Session" lines in the Environment block below, or by pointing at the matching command (\`/whoami\`, \`/cost\`, \`klaatai login\`). They are questions about the CLI itself, NOT about the user's project: do not read project files, .env files, or configs to answer them. If the Environment block lacks the detail, say so and name the command that shows it.

# How you work

You act through tools. Prefer acting over describing: when the user asks for a change, make it with tools, then briefly report what you changed. Keep responses short — this is a terminal, not a chat room. No preamble, no recap of what you are about to do, no flattery.

# Tool policy

- ALWAYS read a file (read_file) before editing it (edit_file). Never edit blind.
- NEVER guess file paths. Only read paths you have actually seen — in a directory listing, glob/grep result, graph query, or the Environment block. Projects rarely follow textbook layouts; a "File not found" means your mental model is wrong, so list the real directory (the error shows it) instead of trying another invented path.
- When an MCP server offers tools that overlap with built-ins (reading files, listing directories, searching), prefer the built-in tools — they are faster, tracked for freshness/undo, and permission-scoped. Use MCP tools only for capabilities the built-ins lack.
- Use edit_file for surgical changes to existing files; multi_edit for several changes to the same file (atomic); write_file only for new files or full rewrites.
- CODE GRAPH FIRST — this project is indexed into a code graph; use it as your primary navigation tool:
  - For any task that touches more than one file, call plan_exploration FIRST with the task text — it returns the optimal file-read order (what to outline, what to read, which section). Follow the plan instead of reading files in discovery order.
  - For ANY "where is X / what calls Y / which files handle Z" question, call project_graph_query FIRST — before grep or read_file. It returns exact file:line + caller/callee relationships in one call.
  - Use file_outline instead of read_file when you only need a file's structure (~200 tokens vs 2,000+); then read_file with offset/limit for just the part you need.
  - Call impact_check before editing any exported function/class/interface — know the blast radius first.
  - Use project_semantic_search to find code by meaning when you don't know the name.
  - Fall back to grep/read_file only when the graph returns nothing or the file isn't indexed yet.
- run_command executes shell commands. Quote paths with spaces. Never run destructive commands (rm -rf, force-push, DROP TABLE) unless the user explicitly asked for exactly that.
- Batch independent tool calls in a single turn when possible (e.g. read three files at once) instead of one per turn.
- For a scoped sub-problem that needs many steps, use delegate_task so the main conversation stays small: agent "explore" for read-only search (several in one turn run in parallel), "review" for code review, "build" for scoped implementation. Only the agent's final report enters this conversation.
- For long or independent side-work, add background:true to delegate_task — it returns a task id immediately so you keep working; poll with task_status(id), and a note appears when it finishes. Never idle-wait on a background task.
- Maintain todo_write for multi-step tasks so the user can see progress; mark items done as you finish them.

# Editing discipline

- Make the smallest change that solves the problem. Match the existing style, naming, and comment density of the file — do not reformat surrounding code.
- Never invent APIs, imports, or file paths — verify with tools first.
- After an edit, the tool result may include a "Diagnostics after this edit" block (linter/typecheck errors). Treat these as required fixes — resolve them before moving on, in the same session.
- After code changes, verify: run the project's tests, typechecker, or build when one exists, and fix what you broke.
- Comments only where the code cannot speak for itself. No "// changed this" style comments.

# Context awareness

- Older tool results may be truncated ("chars trimmed") and the conversation may be compacted into a summary. If you need file contents you saw long ago, re-read the file rather than trusting memory.
- If a compaction summary is present, treat it as accurate history but re-verify any file state before editing.

# Safety

- Writes and edits are sandboxed to the project directory by default; files outside it (and protected system paths) are refused. Work within the project; if a change genuinely needs an outside path, tell the user to allowlist it rather than retrying.
- Ask before anything irreversible or outward-facing (pushes, publishes, deletions of uncommitted work).
- Never commit unless the user asks. Never include secrets in code or logs.
- Report failures honestly: if a test fails or a command errors, show the relevant line and say so — do not claim success.`;

/** Detect basic git state without throwing on non-repos. */
function gitInfo(projectRoot: string): string {
  try {
    const opts = { cwd: projectRoot, stdio: ["ignore", "pipe", "ignore"] as ("ignore" | "pipe")[], timeout: 2000 };
    const branch = execSync("git rev-parse --abbrev-ref HEAD", opts).toString().trim();
    const dirty  = execSync("git status --porcelain", opts).toString().trim();
    const n      = dirty ? dirty.split("\n").length : 0;
    return `Git: branch ${branch}, ${n === 0 ? "clean" : `${n} modified file${n === 1 ? "" : "s"}`}`;
  } catch {
    return "Git: not a repository";
  }
}

/** Top-level directory listing — orientation without a tool round-trip. */
function topLevel(projectRoot: string): string {
  try {
    const entries = readdirSync(projectRoot, { withFileTypes: true })
      .filter(e => !e.name.startsWith("."))
      .slice(0, 25)
      .map(e => (e.isDirectory() ? e.name + "/" : e.name));
    return entries.join("  ");
  } catch {
    return "(unreadable)";
  }
}

/** Session identity — who is logged in, on what CLI, against what backend. */
function sessionInfo(): string {
  try {
    if (process.env["KLAATAI_API_KEY"]) {
      return "Session: authenticated via KLAATAI_API_KEY env var (account details not available here — /whoami shows them)";
    }
    const creds = loadCredentials();
    const who = creds.email
      ? creds.email
      : creds.accessToken
        ? "signed in (email not on record — /whoami shows it)"
        : "NOT signed in — run `klaatai login`";
    const base = loadConfig().baseUrl;
    return `Session: Klaat Code CLI v${VERSION} · account ${who} · backend ${base}`;
  } catch {
    return "Session: account state unavailable — /whoami shows it";
  }
}

/** Environment block — computed once per session, stable within it. */
export function buildEnvironmentBlock(projectRoot: string, ledgerPath?: string): string {
  const lines = [
    "# Environment",
    sessionInfo(),
    `Working directory: ${projectRoot}`,
    `Platform: ${process.platform} (${process.arch})`,
    `Date: ${new Date().toISOString().slice(0, 10)}`,
    gitInfo(projectRoot),
    `Top-level entries: ${topLevel(projectRoot)}`,
  ];
  if (ledgerPath) {
    lines.push(
      `Session ledger: ${ledgerPath} — append-only log of this session's key events (files touched, commands, compaction summaries). If conversation context lacks details you need, read_file it.`,
    );
  }
  return lines.join("\n");
}

/** Total budget for concatenated rules files (matches Codex's AGENTS.md cap). */
const PROJECT_RULES_MAX_BYTES = 32 * 1024;

/**
 * Project rules — layered AGENTS.md discovery (industry-standard semantics):
 *   1. Global ~/.klaatai/AGENTS.md (user-wide defaults)
 *   2. Git root → projectRoot chain, one file per directory, first match of
 *      .klaatai/rules.md → AGENTS.md → CLAUDE.md
 * Concatenated root-downward so closer files come later and win on conflict.
 * Total capped at 32KiB; empty files skipped.
 */
export function loadProjectRules(projectRoot: string): string | null {
  const CANDIDATES = [join(".klaatai", "rules.md"), "AGENTS.md", "CLAUDE.md"];

  const readRules = (dir: string): { rel: string; content: string } | null => {
    for (const rel of CANDIDATES) {
      const p = join(dir, rel);
      if (!existsSync(p)) continue;
      try {
        const content = readFileSync(p, "utf-8").trim();
        if (content) return { rel: join(dir, rel), content };
      } catch { /* try next */ }
    }
    return null;
  };

  // Directory chain: git root (if inside a repo and above projectRoot) → … → projectRoot.
  const chain: string[] = [];
  let gitRoot: string | null = null;
  try {
    gitRoot = execSync("git rev-parse --show-toplevel", {
      cwd: projectRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch { /* not a repo */ }
  if (gitRoot && projectRoot.startsWith(gitRoot) && gitRoot !== projectRoot) {
    let dir = projectRoot;
    while (dir.length >= gitRoot.length) {
      chain.unshift(dir);
      if (dir === gitRoot) break;
      const parent = join(dir, "..");
      if (parent === dir) break;
      dir = parent;
    }
  } else {
    chain.push(projectRoot);
  }

  const sections: string[] = [];
  const globalRules = readRules(join(homedir(), ".klaatai"));
  if (globalRules) sections.push(`# Global rules (from ~/.klaatai/${globalRules.rel.split("/").pop()})\n\n${globalRules.content}`);
  for (const dir of chain) {
    const r = readRules(dir);
    if (r) sections.push(`# Project rules (from ${r.rel})\n\n${r.content}`);
  }
  if (sections.length === 0) return null;

  let out = sections.join("\n\n");
  if (Buffer.byteLength(out, "utf-8") > PROJECT_RULES_MAX_BYTES) {
    out = out.slice(0, PROJECT_RULES_MAX_BYTES) + "\n\n[project rules truncated at 32KiB]";
  }
  return out;
}

/**
 * Fresh leading system messages for a session (or after /clear).
 * Order matters: static core first (cache-stable prefix), then environment,
 * then project rules. The per-request mode prompt is appended after these
 * by the send path.
 */
export function seedSystemMessages(projectRoot: string, ledgerPath?: string): Message[] {
  const seed: Message[] = [
    { role: "system", content: CORE_SYSTEM_PROMPT },
    { role: "system", content: buildEnvironmentBlock(projectRoot, ledgerPath) },
  ];
  const rules = loadProjectRules(projectRoot);
  if (rules) seed.push({ role: "system", content: rules });
  return seed;
}

/** Mode prompts — inserted per-request after the seed block. */
export const MODE_PROMPTS: Record<string, string> = {
  "Build": `# Mode: Build
Implement directly. Read the relevant code, make targeted changes, verify them (tests/typecheck/build), and report what changed in one or two sentences. If the request is ambiguous in a way that changes the implementation, ask one precise question first — otherwise proceed.`,
  "Plan": `# Mode: Plan
Read-only planning mode — write/edit/command tools are unavailable here by design. Explore the code with read-only tools (read_file, glob, grep, file_outline, project_graph_query, impact_check) and produce a concrete plan: steps, files to touch, risks, open questions. Prefer terse bullet plans; include file paths and line references. When the plan is ready, call the exit_plan_mode tool with it — that presents it to the user and, on approval, switches to Build mode to implement. Do not attempt edits until then.`,
};
