/**
 * Subagent personas — persona-as-data (Claude Code pattern).
 *
 * A persona bundles: system prompt, tool allowlist, preferred routing tier,
 * and a loop cap. Read-only personas run without permission prompts and can
 * fan out in parallel; write-capable personas go through the normal
 * permission flow once at delegation time.
 *
 * The token story: exploration noise (file dumps, grep output) stays inside
 * the subagent's context and dies with it — only the final report returns to
 * the parent conversation.
 */

export interface Persona {
  name: string;
  description: string;
  /** Tool names the subagent may use; null = all tools. */
  allowedTools: string[] | null;
  /** True when every allowed tool is read-only — runs silently, parallel-safe. */
  readonly: boolean;
  /** Preferred routing tier (overridable per call). */
  tier: string;
  /** Max model round-trips before the subagent is stopped. */
  loopLimit: number;
  systemPrompt: string;
}

const READ_ONLY_TOOLS = [
  "read_file", "list_dir", "glob", "grep",
  "file_outline", "project_graph_query", "project_semantic_search", "impact_check",
  "plan_exploration",
  "web_fetch", "web_search", "todo_read",
];

export const PERSONAS: Record<string, Persona> = {
  explore: {
    name: "explore",
    description: "Read-only codebase exploration and search",
    allowedTools: READ_ONLY_TOOLS,
    readonly: true,
    tier: "fast",
    loopLimit: 15,
    systemPrompt:
      "You are a read-only exploration agent. Find and report — never modify. " +
      "Use glob/grep/file_outline/project_graph_query to locate code; read only what you must. " +
      "Your final message is your report to the caller: state conclusions with file paths and line numbers, " +
      "not raw file dumps. Be complete but dense — the caller's context is expensive.",
  },
  review: {
    name: "review",
    description: "Read-only code review of specific files or diffs",
    allowedTools: READ_ONLY_TOOLS,
    readonly: true,
    tier: "reason",
    loopLimit: 15,
    systemPrompt:
      "You are a code-review agent. Read the specified code and report problems: bugs, edge cases, " +
      "security issues, needless complexity. Never modify files. " +
      "Final message = review report: one line per finding — location (file:line), problem, suggested fix. " +
      "Rank by severity. Say 'no significant issues' if clean; do not invent findings.",
  },
  build: {
    name: "build",
    description: "Implementation agent with full tool access",
    allowedTools: null,
    readonly: false,
    tier: "code",
    loopLimit: 25,
    systemPrompt:
      "You are an implementation agent working on a scoped task. Read before editing, make targeted changes, " +
      "verify with the project's tests or typechecker when available. " +
      "Final message = a concise report of what changed (files + why) and verification results.",
  },
  general: {
    name: "general",
    description: "General-purpose agent (default)",
    allowedTools: null,
    readonly: false,
    tier: "code",
    loopLimit: 10,
    systemPrompt:
      "You are a sub-agent handling a scoped task for the main conversation. " +
      "Your final message is returned to the caller — make it a concise, complete report of what you found or did.",
  },
};

export function getPersona(name: string | undefined): Persona {
  return PERSONAS[name ?? "general"] ?? PERSONAS["general"]!;
}
