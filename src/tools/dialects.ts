/**
 * Toolset dialects — tier-aware tool schema selection.
 *
 * Klaatu routes every request to a different model tier; a fixed 27-tool
 * schema is wrong at the edges. Strong tiers (code/reason/heavy) handle the
 * full set; the fast tier gets a trimmed core set (fewer schemas = fewer
 * prompt tokens, less tool-choice confusion on small models); nano also gets
 * the concise set (see dialectForTier for why never zero tools).
 *
 * Selection is by tier only: the pinned tier when the user forced one
 * (/tier), otherwise the last served tier reported by the server (sticky
 * approximation — Klaatu session pins keep it stable within a session).
 * Custom third-party endpoints (/model add) always get the full dialect;
 * their capabilities are the user's call.
 *
 * Each dialect's tool list is a static, memoized subset of TOOL_DEFINITIONS —
 * byte-stable across turns so the request prefix stays prompt-cache friendly.
 *
 * Explicit persona allowlists (personas.ts) outrank the dialect: a curated
 * list expresses intent, e.g. the fast-tier explore persona deliberately
 * carries impact_check/project_semantic_search which the concise dialect
 * drops for general use.
 */

import type { ToolDefinition } from "../api/client.js";

export type ToolDialect = "full" | "concise" | "minimal";

/** Core tool subset for the fast tier: the read/search/edit/run loop plus
 * planning and web access. Dropped vs full: apply_patch (patch envelope is
 * error-prone on small models — edit_file/multi_edit cover it), subagent
 * orchestration (delegate_task/task_status — the parent orchestrates, not a
 * fast-tier worker), browser_* (5 tools, rarely useful on quick tasks), and
 * the two heavyweight graph tools (impact_check, project_semantic_search —
 * file_outline + project_graph_query remain for navigation). */
const CONCISE_TOOLS = new Set([
  "read_file", "write_file", "edit_file", "multi_edit",
  "glob", "grep", "list_dir",
  "run_command", "shell_output", "shell_kill",
  "web_fetch", "web_search",
  "todo_read", "todo_write", "ask_user",
  "file_outline", "project_graph_query",
]);

/** Map a routing tier to a dialect. Unknown/smart/auto → full (the server
 * may serve any tier; the full set is the safe default).
 *
 * nano maps to CONCISE, never minimal: Klaatu's OpenAI endpoint classifies a
 * request with no tools array as a WEB client (`bool(body.tools)` gate) and
 * routes it into the web-chat pipeline, whose system prompt replaces ours and
 * carries `<klaatu_creation>` HTML formatting rules — raw HTML in the
 * terminal (found live 2026-07-19). The server skips tool schemas for the
 * nano tier itself, so sending the concise set costs nothing model-side while
 * keeping the request on the editor path. "minimal" stays for callers that
 * explicitly want a toolless request (they own the consequences). */
export function dialectForTier(tier: string | null | undefined): ToolDialect {
  switch ((tier ?? "").toLowerCase()) {
    case "nano": return "concise";
    case "fast": return "concise";
    default:     return "full";
  }
}

/** True when MCP + plugin tools should be appended for this dialect. */
export function dialectIncludesExtras(dialect: ToolDialect): boolean {
  return dialect !== "minimal";
}

// Memoized per (dialect, base array identity) so repeated turns reuse the
// exact same array/object instances — byte-stable serialization.
const cache = new Map<ToolDialect, { base: ToolDefinition[]; result: ToolDefinition[] }>();

/** Return the built-in tool definitions for a dialect. */
export function toolsForDialect(
  dialect: ToolDialect,
  base: ToolDefinition[],
): ToolDefinition[] {
  if (dialect === "full") return base;
  if (dialect === "minimal") return [];
  const hit = cache.get(dialect);
  if (hit && hit.base === base) return hit.result;
  const result = base.filter(t => CONCISE_TOOLS.has(t.function.name));
  cache.set(dialect, { base, result });
  return result;
}
