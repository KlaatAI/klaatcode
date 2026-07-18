import { describe, expect, test } from "bun:test";
import { dialectForTier, toolsForDialect, dialectIncludesExtras } from "./dialects.js";
import { TOOL_DEFINITIONS } from "./index.js";

describe("dialectForTier", () => {
  // nano must NEVER map to minimal: an empty tools array makes Klaatu's
  // OpenAI endpoint treat the request as a web client and swap in the
  // web-chat system prompt (<klaatu_creation> HTML leak, 2026-07-19).
  test("nano → concise (never toolless)", () => expect(dialectForTier("nano")).toBe("concise"));
  test("fast → concise", () => expect(dialectForTier("fast")).toBe("concise"));
  test("strong tiers → full", () => {
    for (const t of ["code", "reason", "heavy"]) expect(dialectForTier(t)).toBe("full");
  });
  test("smart/auto/unknown/absent → full", () => {
    for (const t of ["smart", "auto", "weird", "", null, undefined]) {
      expect(dialectForTier(t)).toBe("full");
    }
  });
  test("case-insensitive", () => expect(dialectForTier("FAST")).toBe("concise"));
});

describe("toolsForDialect", () => {
  test("full returns the base array untouched (same identity)", () => {
    expect(toolsForDialect("full", TOOL_DEFINITIONS)).toBe(TOOL_DEFINITIONS);
  });

  test("minimal returns no tools", () => {
    expect(toolsForDialect("minimal", TOOL_DEFINITIONS)).toEqual([]);
  });

  test("concise is a strict subset with the core loop intact", () => {
    const concise = toolsForDialect("concise", TOOL_DEFINITIONS);
    const names = new Set(concise.map(t => t.function.name));
    expect(concise.length).toBeGreaterThan(0);
    expect(concise.length).toBeLessThan(TOOL_DEFINITIONS.length);
    for (const kept of ["read_file", "edit_file", "multi_edit", "run_command", "grep", "todo_write"]) {
      expect(names.has(kept)).toBe(true);
    }
    for (const dropped of ["apply_patch", "delegate_task", "task_status", "browser_navigate", "impact_check", "project_semantic_search"]) {
      expect(names.has(dropped)).toBe(false);
    }
  });

  test("every concise tool exists in TOOL_DEFINITIONS (no drift)", () => {
    // If a tool is renamed in index.ts, the concise set silently shrinking
    // would be a routing regression — pin the expected count.
    expect(toolsForDialect("concise", TOOL_DEFINITIONS).length).toBe(17);
  });

  test("memoized: repeated calls return the same array instance (prompt-cache byte-stability)", () => {
    const a = toolsForDialect("concise", TOOL_DEFINITIONS);
    const b = toolsForDialect("concise", TOOL_DEFINITIONS);
    expect(a).toBe(b);
  });
});

describe("dialectIncludesExtras", () => {
  test("MCP/plugin tools ride along except on minimal", () => {
    expect(dialectIncludesExtras("full")).toBe(true);
    expect(dialectIncludesExtras("concise")).toBe(true);
    expect(dialectIncludesExtras("minimal")).toBe(false);
  });
});
