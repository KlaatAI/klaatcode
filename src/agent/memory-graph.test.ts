import { describe, test, expect } from "bun:test";
import { parseMemorySections, buildPersonaGraph } from "./memory-graph.js";

const PROJECT_MD = `## Commands
- bun test runs the suite
- bunx tsc --noEmit typechecks

## Conventions
- tests colocated next to source

## Corrections
- never use npm — the project is bun-only
`;

const USER_MD = `- prefers terse answers
- comfortable with Hindi and English
`;

describe("parseMemorySections", () => {
  test("headings become sections, bullets become facts", () => {
    const p = parseMemorySections(PROJECT_MD);
    expect(p.sections.map(s => s.heading)).toEqual(["Commands", "Conventions", "Corrections"]);
    expect(p.sections[0]!.facts).toHaveLength(2);
    expect(p.preamble).toHaveLength(0);
  });

  test("bullets before any heading land in preamble", () => {
    const p = parseMemorySections(USER_MD);
    expect(p.sections).toHaveLength(0);
    expect(p.preamble).toEqual(["prefers terse answers", "comfortable with Hindi and English"]);
  });

  test("empty sections are dropped", () => {
    const p = parseMemorySections("## Empty\n\n## Full\n- one fact\n");
    expect(p.sections.map(s => s.heading)).toEqual(["Full"]);
  });
});

describe("buildPersonaGraph", () => {
  test("two roots, hubs per section, leaves per fact, all connected", () => {
    const g = buildPersonaGraph({
      projectName: "KlaatAI", projectMemory: PROJECT_MD, userMemory: USER_MD,
    })!;
    expect(g).not.toBeNull();
    expect(g.showLabels).toBe(true);
    const ids = g.nodes.map(n => n.file);
    expect(ids).toContain("You");
    expect(ids).toContain("KlaatAI");
    expect(ids).toContain("Corrections");
    expect(ids.some(f => f.includes("bun-only"))).toBe(true);
    // Every edge endpoint resolves to a node (renderGraphHtml drops orphans).
    const idSet = new Set(ids);
    for (const e of g.edges) {
      expect(idSet.has(e.a)).toBe(true);
      expect(idSet.has(e.b)).toBe(true);
    }
    // Every non-root node is reachable: edges = nodes - 2 roots... each node
    // except the two roots has exactly one incoming edge in this tree shape.
    expect(g.edges.length).toBe(g.nodes.length - 2);
  });

  test("duplicate fact texts get unique node ids", () => {
    const g = buildPersonaGraph({
      projectName: "P",
      projectMemory: "## A\n- same fact\n## B\n- same fact\n",
      userMemory: "",
    })!;
    const ids = g.nodes.map(n => n.file);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("both memories empty yields null", () => {
    expect(buildPersonaGraph({ projectName: "P", projectMemory: "", userMemory: "" })).toBeNull();
  });

  test("long facts are clipped for display", () => {
    const g = buildPersonaGraph({
      projectName: "P",
      projectMemory: `## Notes\n- ${"x".repeat(200)}\n`,
      userMemory: "",
    })!;
    for (const n of g.nodes) expect(n.file.length).toBeLessThanOrEqual(60);
  });
});
