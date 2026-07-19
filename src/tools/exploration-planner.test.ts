import { describe, expect, test } from "bun:test";
import { extractKeywords, buildPlan, renderPlan, type GraphAccess } from "./exploration-planner.js";

const EMPTY_GRAPH: GraphAccess = { query: () => [], callers: () => [] };

function makeGraph(
  symbols: Record<string, Array<{ name: string; kind: string; file: string; line: number }>>,
  callers: Record<string, Array<{ callerName: string; callerFile: string; hop: number }>> = {},
): GraphAccess {
  return {
    query: (kw, limit) => {
      const hits: Array<{ name: string; kind: string; file: string; line: number }> = [];
      for (const [key, syms] of Object.entries(symbols)) {
        if (key.toLowerCase().includes(kw.toLowerCase()) || kw.toLowerCase().includes(key.toLowerCase())) {
          hits.push(...syms);
        }
      }
      return hits.slice(0, limit);
    },
    callers: (name) => callers[name] ?? [],
  };
}

describe("extractKeywords", () => {
  test("pulls quoted identifiers and paths", () => {
    const { paths, terms } = extractKeywords(
      "fix the bug in `compactMessagesForApi` inside 'src/agent/compaction.ts'");
    expect(paths).toContain("src/agent/compaction.ts");
    expect(terms).toContain("compactMessagesForApi");
  });

  test("finds bare paths and file names", () => {
    const { paths } = extractKeywords("update repl.ts and src/tools/index.ts to add the flag");
    expect(paths).toContain("repl.ts");
    expect(paths).toContain("src/tools/index.ts");
  });

  test("keeps camelCase and snake_case, drops stopwords", () => {
    const { terms } = extractKeywords(
      "the parseQuotaHeaders function should handle max_send_chars when the file changes");
    expect(terms).toContain("parseQuotaHeaders");
    expect(terms).toContain("max_send_chars");
    expect(terms).not.toContain("should");
    expect(terms).not.toContain("function");
  });

  test("empty task yields empty keywords", () => {
    const { paths, terms } = extractKeywords("");
    expect(paths).toHaveLength(0);
    expect(terms).toHaveLength(0);
  });

  test("caps keyword counts", () => {
    const many = Array.from({ length: 40 }, (_, i) => `someSymbolName${i}`).join(" ");
    const { terms } = extractKeywords(many);
    expect(terms.length).toBeLessThanOrEqual(10);
  });
});

describe("buildPlan", () => {
  test("named files come first as full reads", () => {
    const plan = buildPlan("fix validateToken in src/auth/token.ts", makeGraph({
      validateToken: [{ name: "validateToken", kind: "function", file: "src/auth/token.ts", line: 42 }],
    }));
    expect(plan[0]!.file).toBe("src/auth/token.ts");
    expect(plan[0]!.mode).toBe("read");
    expect(plan[0]!.rationale).toContain("named in the task");
  });

  test("symbol hits become section reads with line, callers become outlines", () => {
    const plan = buildPlan("refactor the parseQuota logic", makeGraph(
      { parseQuota: [{ name: "parseQuota", kind: "function", file: "src/api/quota.ts", line: 120 }] },
      { parseQuota: [
        { callerName: "renderCost", callerFile: "src/screens/cost.ts", hop: 1 },
        { callerName: "deepCaller", callerFile: "src/deep.ts", hop: 2 },
      ] },
    ));
    const section = plan.find(s => s.file === "src/api/quota.ts");
    expect(section?.mode).toBe("section");
    expect(section?.line).toBe(120);
    const caller = plan.find(s => s.file === "src/screens/cost.ts");
    expect(caller?.mode).toBe("outline");
    expect(caller?.rationale).toContain("parseQuota");
    // hop-2 callers excluded
    expect(plan.find(s => s.file === "src/deep.ts")).toBeUndefined();
  });

  test("dedupes: a file appears once with its strongest mode", () => {
    const plan = buildPlan("fix parseQuota in src/api/quota.ts", makeGraph({
      parseQuota: [{ name: "parseQuota", kind: "function", file: "src/api/quota.ts", line: 120 }],
    }));
    expect(plan.filter(s => s.file === "src/api/quota.ts")).toHaveLength(1);
    expect(plan[0]!.mode).toBe("read"); // named-in-task wins (came first)
  });

  test("respects max_files cap", () => {
    const syms = Array.from({ length: 20 }, (_, i) =>
      ({ name: `handler${i}`, kind: "function", file: `src/h/${i}.ts`, line: 1 }));
    const plan = buildPlan("update the requestHandler pipeline", makeGraph({ handler: syms }), 5);
    expect(plan.length).toBeLessThanOrEqual(5);
  });

  test("empty graph and no paths yields empty plan", () => {
    expect(buildPlan("do something vague", EMPTY_GRAPH)).toHaveLength(0);
  });
});

describe("renderPlan", () => {
  test("empty plan returns actionable fallback message", () => {
    const out = renderPlan("task", []);
    expect(out).toContain("No exploration plan");
    expect(out).toContain("indexing runs");
  });

  test("renders ordered steps with tool guidance", () => {
    const out = renderPlan("t", [
      { file: "a.ts", mode: "read", rationale: "named in the task" },
      { file: "b.ts", mode: "section", line: 100, rationale: "defines function `x`" },
      { file: "c.ts", mode: "outline", rationale: "calls `x`" },
    ]);
    expect(out).toContain("1. a.ts — read");
    expect(out).toContain("2. b.ts — section (read_file offset≈80 limit≈60)");
    expect(out).toContain("3. c.ts — outline (file_outline)");
    expect(out).toContain("impact_check");
  });
});
