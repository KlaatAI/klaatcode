/**
 * Compat: honor permissions.allow/deny/ask from .claude/settings.json (and
 * .claude/settings.local.json, which wins on conflict) so teams switching
 * from Claude Code keep their curated guardrails.
 *
 * This is a rule-matching layer that sits *in front of* the native
 * permission model in ./index.ts. It never overrides a native decision —
 * see resolveImportedDecision() in index.ts for how the two are combined.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ToolCall } from "../api/client.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ClaudeSettingsFile {
  permissions?: {
    allow?: string[];
    deny?: string[];
    ask?: string[];
  };
}

export interface ParsedRule {
  /** The raw rule string, e.g. "Bash(git *)" — kept for logging/tests. */
  raw: string;
  /** Claude Code tool name, e.g. "Bash", "Edit". */
  tool: string;
  /** Text inside the parens, if any, e.g. "git *" or "domain:example.com". */
  arg?: string;
}

export interface CompiledRules {
  allow: ParsedRule[];
  deny: ParsedRule[];
  ask: ParsedRule[];
  /** Rules whose tool name has no mapping onto our tools — logged, then skipped. */
  unmappable: ParsedRule[];
}

export type ImportedDecision = "allow" | "deny" | "ask" | null;

// ─── Tool name mapping ───────────────────────────────────────────────────────

/** Claude Code tool name -> our internal tool name(s). */
export const CLAUDE_TOOL_MAP: Record<string, string[]> = {
  Bash: ["run_command"],
  Read: ["read_file"],
  Write: ["write_file"],
  Edit: ["edit_file", "multi_edit", "apply_patch"],
  Glob: ["glob"],
  Grep: ["grep"],
  LS: ["list_dir"],
  WebFetch: ["web_fetch"],
  WebSearch: ["web_search"],
};

// ─── Parsing ─────────────────────────────────────────────────────────────────

const RULE_RE = /^([A-Za-z_]+)(?:\((.*)\))?$/;

export function parseRule(raw: string): ParsedRule | null {
  const m = RULE_RE.exec(raw.trim());
  if (!m) return null;
  const arg = m[2];
  return { raw, tool: m[1]!, arg: arg === undefined ? undefined : arg.trim() };
}

/**
 * Merge global (.claude/settings.json) and local (.claude/settings.local.json)
 * rule lists. Local wins: any rule string present in local is removed from
 * global's categories first, so a rule can't linger in both an allow and a
 * deny list after a local override.
 */
function mergeCategories(
  global: ClaudeSettingsFile["permissions"],
  local: ClaudeSettingsFile["permissions"],
): { allow: string[]; deny: string[]; ask: string[] } {
  const g = { allow: global?.allow ?? [], deny: global?.deny ?? [], ask: global?.ask ?? [] };
  const l = { allow: local?.allow ?? [], deny: local?.deny ?? [], ask: local?.ask ?? [] };
  const localRules = new Set([...l.allow, ...l.deny, ...l.ask]);

  const dedupe = (base: string[], override: string[]) =>
    Array.from(new Set([...base.filter(r => !localRules.has(r)), ...override]));

  return {
    allow: dedupe(g.allow, l.allow),
    deny: dedupe(g.deny, l.deny),
    ask: dedupe(g.ask, l.ask),
  };
}

function readSettingsFile(path: string): ClaudeSettingsFile | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8")) as ClaudeSettingsFile;
  } catch {
    return null;
  }
}

/**
 * Load and compile .claude/settings.json (+ settings.local.json) from a
 * project root. Returns null when neither file exists, so callers can skip
 * the whole layer with zero behavior change (acceptance criterion).
 */
export function loadClaudeCompatRules(projectRoot: string): CompiledRules | null {
  const globalPath = join(projectRoot, ".claude", "settings.json");
  const localPath = join(projectRoot, ".claude", "settings.local.json");
  const global = readSettingsFile(globalPath);
  const local = readSettingsFile(localPath);
  if (!global && !local) return null;

  const merged = mergeCategories(global?.permissions, local?.permissions);
  const compiled: CompiledRules = { allow: [], deny: [], ask: [], unmappable: [] };

  for (const [category, rules] of [
    ["allow", merged.allow],
    ["deny", merged.deny],
    ["ask", merged.ask],
  ] as const) {
    for (const raw of rules) {
      const parsed = parseRule(raw);
      if (!parsed) { compiled.unmappable.push({ raw, tool: raw }); continue; }
      if (!CLAUDE_TOOL_MAP[parsed.tool]) { compiled.unmappable.push(parsed); continue; }
      compiled[category].push(parsed);
    }
  }

  return compiled;
}

// ─── Matching ────────────────────────────────────────────────────────────────

/** `*` -> any run of chars (used for Bash command patterns). */
function globToRegexSingleStar(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** Gitignore-ish glob: `**` crosses directories, `*` stays within a segment. */
function globToRegexPath(pattern: string): RegExp {
  const placeholder = "\u0000DOUBLESTAR\u0000";
  let escaped = pattern
    .replace(/\*\*/g, placeholder)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(new RegExp(placeholder, "g"), ".*");
  return new RegExp(`^${escaped}$`);
}

function extractPatchPaths(patch: string): string[] {
  const paths: string[] = [];
  const re = /^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(patch)) !== null) paths.push(m[1]!.trim());
  return paths;
}

function safeArgs(tc: ToolCall): Record<string, unknown> {
  try { return JSON.parse(tc.function.arguments) as Record<string, unknown>; }
  catch { return {}; }
}

/** Does a single parsed rule match this tool call? */
export function ruleMatchesCall(rule: ParsedRule, tc: ToolCall): boolean {
  const mapped = CLAUDE_TOOL_MAP[rule.tool];
  if (!mapped || !mapped.includes(tc.function.name)) return false;
  if (rule.arg === undefined) return true; // bare tool name — matches every call

  const args = safeArgs(tc);

  switch (rule.tool) {
    case "Bash": {
      const cmd = String(args["command"] ?? "");
      return globToRegexSingleStar(rule.arg.trim()).test(cmd.trim());
    }
    case "WebFetch": {
      const domainMatch = /^domain:(.+)$/.exec(rule.arg.trim());
      if (!domainMatch) return false;
      try {
        const host = new URL(String(args["url"] ?? "")).hostname;
        return host === domainMatch[1] || host.endsWith(`.${domainMatch[1]}`);
      } catch { return false; }
    }
    case "Read":
    case "Write":
    case "Glob":
    case "Grep":
    case "LS": {
      const path = String(args["path"] ?? args["pattern"] ?? "");
      return globToRegexPath(rule.arg.trim()).test(path);
    }
    case "Edit": {
      if (tc.function.name === "apply_patch") {
        const patch = String(args["patch"] ?? "");
        const re = globToRegexPath(rule.arg.trim());
        return extractPatchPaths(patch).some(p => re.test(p));
      }
      const path = String(args["path"] ?? "");
      return globToRegexPath(rule.arg.trim()).test(path);
    }
    default:
      return false;
  }
}

/**
 * Check a tool call against imported .claude rules only.
 * Precedence within this layer: deny > ask > allow.
 * Returns null when nothing matches (caller falls back to native "ask").
 */
export function checkImportedRules(tc: ToolCall, rules: CompiledRules): ImportedDecision {
  if (rules.deny.some(r => ruleMatchesCall(r, tc))) return "deny";
  if (rules.ask.some(r => ruleMatchesCall(r, tc))) return "ask";
  if (rules.allow.some(r => ruleMatchesCall(r, tc))) return "allow";
  return null;
}

/** One-line startup summary, or null if there's nothing to report. */
export function summarizeCompatRules(rules: CompiledRules | null): string | null {
  if (!rules) return null;
  const total = rules.allow.length + rules.deny.length + rules.ask.length;
  if (total === 0 && rules.unmappable.length === 0) return null;
  const parts = [`${total} rule${total === 1 ? "" : "s"} from .claude/settings.json`];
  if (rules.unmappable.length > 0) {
    parts.push(`${rules.unmappable.length} unmappable rule${rules.unmappable.length === 1 ? "" : "s"} skipped`);
  }
  return `Compat: honoring ${parts.join(", ")}.`;
}