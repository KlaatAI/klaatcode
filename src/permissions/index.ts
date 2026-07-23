/**
 * Permission system for the KlaatAI CLI.
 *
 * Three permission tiers:
 *   1. SAFE_TOOLS   — read-only tools, always allowed, no prompt
 *   2. WRITE_TOOLS  — file-mutating tools (write_file, edit_file), ask once per session
 *   3. run_command  — shell execution, ask every time unless a saved pattern matches
 *
 * Saved state: ~/.klaatai/permissions.json
 *
 * Decisions:
 *   allow_once    — allow this specific call, ask again next time
 *   allow_session — allow all calls to this tool for the rest of the session (in-memory)
 *   allow_always  — persist: run_command → add command to allowed_commands;
 *                            write/edit   → add tool to trusted_tools
 *   deny          — reject, return error string to model
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ToolCall } from "../api/client.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const KLAATAI_DIR = join(homedir(), ".klaatai");
const PERMISSIONS_FILE = join(KLAATAI_DIR, "permissions.json");

/** Tools that are read-only and never need a permission prompt. */
export const SAFE_TOOLS = new Set([
  "read_file",
  "list_dir",
  "glob",
  "grep",
  // Read-only code-graph and local-state tools — no writes, no side effects.
  "file_outline",
  "project_graph_query",
  "project_semantic_search",
  "impact_check",
  "plan_exploration",
  "todo_read",
  // Background-shell polling/stop — only affect processes the model itself started.
  "shell_output",
  "shell_kill",
  // Background-agent polling — read-only view of tasks the model itself spawned.
  "task_status",
]);

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PermissionsFile {
  /** Tool names (write_file / edit_file) the user has permanently trusted. */
  trusted_tools: string[];
  /** Glob-style command patterns that are always allowed for run_command. */
  allowed_commands: string[];
  /** Glob-style command patterns that are always denied for run_command. */
  denied_commands: string[];
}

export type PermDecision = "allow_once" | "allow_session" | "allow_always" | "deny";
export type PermCheckResult = "allow" | "deny" | "ask";

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_PERMS: PermissionsFile = {
  trusted_tools: [],

  // Conservative read-only commands — safe to auto-approve
  allowed_commands: [
    "git status",
    "git diff",
    "git diff *",
    "git log",
    "git log *",
    "git branch",
    "git branch *",
    "git remote -v",
    "git show *",
    "git stash list",
    "pwd",
    "ls",
    "ls *",
    "which *",
    "echo *",
    "cat *",
    "wc *",
    "head *",
    "tail *",
  ],

  // Patterns that are automatically rejected — prevents accidents
  denied_commands: [
    "rm -rf /",
    "rm -rf ~*",
    "sudo rm *",
    "dd if=*",
    "mkfs *",
    ":(){:|:&};:",    // fork bomb
  ],
};

// ─── Storage ─────────────────────────────────────────────────────────────────

export function loadPermissions(): PermissionsFile {
  try {
    if (!existsSync(PERMISSIONS_FILE)) return { ...DEFAULT_PERMS };
    const raw = JSON.parse(readFileSync(PERMISSIONS_FILE, "utf-8")) as Partial<PermissionsFile>;
    return {
      trusted_tools: raw.trusted_tools ?? DEFAULT_PERMS.trusted_tools,
      allowed_commands: raw.allowed_commands ?? DEFAULT_PERMS.allowed_commands,
      denied_commands: raw.denied_commands ?? DEFAULT_PERMS.denied_commands,
    };
  } catch {
    return { ...DEFAULT_PERMS };
  }
}

export function savePermissions(perms: PermissionsFile): void {
  try {
    mkdirSync(KLAATAI_DIR, { recursive: true });
    writeFileSync(PERMISSIONS_FILE, JSON.stringify(perms, null, 2));
  } catch {
    // best-effort — permission failure shouldn't crash the CLI
  }
}

// ─── Pattern matching ─────────────────────────────────────────────────────────

/**
 * Simple glob-style pattern match (* = any sequence of chars).
 * Case-insensitive, trims both strings.
 */
function matchesPattern(subject: string, pattern: string): boolean {
  const escaped = pattern
    .trim()
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex special chars (not *)
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(subject.trim());
}

// ─── Core logic ───────────────────────────────────────────────────────────────

/**
 * Check whether a tool call needs a permission prompt.
 *
 * Returns:
 *   "allow" — proceed silently
 *   "deny"  — reject silently with an error message
 *   "ask"   — show the PermissionPrompt to the user
 */
export function checkPermission(tc: ToolCall, perms: PermissionsFile): PermCheckResult {
  const tool = tc.function.name;

  // Tier 1: always-safe tools
  if (SAFE_TOOLS.has(tool)) return "allow";

  // Tier 2: tools the user has permanently trusted
  if (perms.trusted_tools.includes(tool)) return "allow";

  // Tier 3: run_command — pattern match against allow/deny lists
  if (tool === "run_command") {
    let args: { command?: string } = {};
    try { args = JSON.parse(tc.function.arguments) as { command?: string }; } catch { /* */ }
    const cmd = args.command ?? "";

    // Deny list takes priority
    for (const pattern of perms.denied_commands) {
      if (matchesPattern(cmd, pattern)) return "deny";
    }
    for (const pattern of perms.allowed_commands) {
      if (matchesPattern(cmd, pattern)) return "allow";
    }
    return "ask";
  }

  // write_file / edit_file — not permanently trusted, ask
  return "ask";
}

/**
 * Apply a user's "allow_always" decision and persist it.
 *
 *   run_command → save the exact command string to allowed_commands
 *   write_file / edit_file → add tool name to trusted_tools
 */
export function persistAlwaysAllow(tc: ToolCall): void {
  const tool = tc.function.name;
  const perms = loadPermissions();

  if (tool === "run_command") {
    let args: { command?: string } = {};
    try { args = JSON.parse(tc.function.arguments) as { command?: string }; } catch { return; }
    const cmd = args.command ?? "";
    if (cmd && !perms.allowed_commands.includes(cmd)) {
      perms.allowed_commands = [cmd, ...perms.allowed_commands];
    }
  } else {
    if (!perms.trusted_tools.includes(tool)) {
      perms.trusted_tools.push(tool);
    }
  }

  savePermissions(perms);
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

/**
 * Human-readable one-line summary of a tool call for the permission prompt.
 * Kept short so it fits on one line in the terminal.
 */
export function summarizeTool(tc: ToolCall): string {
  try {
    const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
    switch (tc.function.name) {
      case "write_file":
        return `write  ${String(args["path"] ?? "?")}`;
      case "edit_file":
        return `edit   ${String(args["path"] ?? "?")}`;
      case "multi_edit": {
        const n = Array.isArray(args["edits"]) ? (args["edits"] as unknown[]).length : "?";
        return `edit   ${String(args["path"] ?? "?")} (${n} edits)`;
      }
      case "apply_patch": {
        const p = String(args["patch"] ?? "");
        const files = (p.match(/^\*\*\* (Add|Update|Delete) File:/gm) ?? []).length;
        return `patch  ${files} file${files === 1 ? "" : "s"}`;
      }
      case "delegate_task": {
        const agent = String(args["agent"] ?? "general");
        const task  = String(args["task"] ?? "?");
        const bg    = args["background"] === true ? "bg " : "";
        return `agent  ${bg}[${agent}] ${task.length > 50 ? task.slice(0, 47) + "…" : task}`;
      }
      case "task_status":
        return `agent  status ${args["id"] ? String(args["id"]) : "(all)"}`;
      case "run_command": {
        const cmd = String(args["command"] ?? "?");
        // Truncate long commands for display
        return `$  ${cmd.length > 60 ? cmd.slice(0, 57) + "…" : cmd}`;
      }
      case "read_file": {
        const path = String(args["path"] ?? "?");
        const off  = args["offset"] ? Number(args["offset"]) : null;
        const lim  = args["limit"]  ? Number(args["limit"])  : null;
        return `read   ${path}${off ? `:${off}${lim ? `–${off + lim - 1}` : "+"}` : ""}`;
      }
      case "list_dir":
        return `ls     ${String(args["path"] ?? ".")}`;
      case "glob":
        return `glob   ${String(args["pattern"] ?? "?")}`;
      case "grep": {
        const pat = String(args["pattern"] ?? "?");
        const where = args["path"] ? ` in ${String(args["path"])}` : "";
        return `grep   "${pat.length > 40 ? pat.slice(0, 37) + "…" : pat}"${where}`;
      }
      case "web_fetch": {
        const url = String(args["url"] ?? "?").replace(/^https?:\/\//, "");
        return `fetch  ${url.length > 55 ? url.slice(0, 52) + "…" : url}`;
      }
      case "web_search":
        return `search "${String(args["query"] ?? "?")}"`;
      case "todo_write":
        return "todo   update list";
      case "todo_read":
        return "todo   read list";
      case "file_outline":
        return `outline ${String(args["path"] ?? "?")}`;
      case "project_graph_query":
        return `graph  ${String(args["query"] ?? "?")}`;
      case "project_semantic_search":
        return `graph  "${String(args["query"] ?? "?")}"`;
      case "impact_check":
        return `impact ${String(args["symbol"] ?? "?")}`;
      default: {
        // MCP and other tools: extract meaningful arg (url, path, query, name)
        const meaningful = args["url"] ?? args["path"] ?? args["query"] ?? args["name"] ?? args["uri"] ?? null;
        if (meaningful) {
          const val = String(meaningful);
          return `${tc.function.name}  ${val.length > 55 ? val.slice(0, 52) + "…" : val}`;
        }
        return tc.function.name;
      }
    }
  } catch {
    return tc.function.name;
  }
}

/**
 * Cap tool results at ~40k chars before sending them to the model.
 * Large outputs (e.g. a full directory_tree of a big project) will exceed the
 * model's context limit and cause a 400 / 502 error. We truncate and append a
 * clear note so the model knows the data was cut.
 */
const MAX_TOOL_RESULT_CHARS = 40_000;

export function truncateToolResult(result: string): string {
  if (result.length <= MAX_TOOL_RESULT_CHARS) return result;
  const omitted = result.length - MAX_TOOL_RESULT_CHARS;
  return (
    result.slice(0, MAX_TOOL_RESULT_CHARS) +
    `\n\n[...${omitted.toLocaleString()} characters truncated — output too large for context window. ` +
    `Ask for a more specific path or use search/grep instead of directory_tree on large projects.]`
  );
}
