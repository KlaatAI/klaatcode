/**
 * M1b — persona graph: the memory files rendered as a force graph.
 *
 * Two roots — "You" (user memory) and the project — with category hubs
 * (Commands, Conventions, Corrections, …) and fact leaves parsed from the
 * memory markdown. Rides the same self-contained renderGraphHtml generator
 * as the G7 code graph, with showLabels on: at persona scale the text IS the
 * content, not a hover detail.
 *
 * Pure module (no fs, no vscode) — mirrored in the VS Code extension.
 */

import type { GraphVizData, GraphVizNode, GraphVizEdge } from "../tools/graph-html.js";

const MAX_FACT_CHARS = 60;

interface ParsedSection { heading: string; facts: string[] }

/** Markdown → sections. Bullets before any heading land in `preamble`. */
export function parseMemorySections(md: string): { preamble: string[]; sections: ParsedSection[] } {
  const preamble: string[] = [];
  const sections: ParsedSection[] = [];
  let cur: ParsedSection | null = null;
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const h = /^#{1,4}\s+(.+?)\s*$/.exec(line);
    if (h) {
      cur = { heading: h[1]!, facts: [] };
      sections.push(cur);
      continue;
    }
    const b = /^[-*•]\s+(.+)$/.exec(line);
    const fact = (b ? b[1]! : line).trim();
    if (!fact) continue;
    if (cur) cur.facts.push(fact);
    else preamble.push(fact);
  }
  return { preamble, sections: sections.filter(s => s.facts.length > 0) };
}

export interface PersonaGraphInput {
  projectName: string;
  projectMemory: string;
  userMemory: string;
}

export function buildPersonaGraph(input: PersonaGraphInput): GraphVizData | null {
  const proj = parseMemorySections(input.projectMemory);
  const user = parseMemorySections(input.userMemory);
  if (proj.sections.length + proj.preamble.length + user.sections.length + user.preamble.length === 0) {
    return null;
  }

  const nodes: GraphVizNode[] = [];
  const edges: GraphVizEdge[] = [];
  const seen = new Set<string>();
  let community = 0;

  const uniq = (label: string): string => {
    let id = label.length > MAX_FACT_CHARS ? label.slice(0, MAX_FACT_CHARS - 1) + "…" : label;
    let n = 2;
    while (seen.has(id)) id = `${id.slice(0, MAX_FACT_CHARS - 4)} (${n++})`;
    seen.add(id);
    return id;
  };

  const addRoot = (
    label: string,
    communityLabel: string,
    parsed: { preamble: string[]; sections: ParsedSection[] },
  ): void => {
    const rootComm = community++;
    const rootId = uniq(label);
    const hubCount = parsed.sections.length + (parsed.preamble.length > 0 ? 1 : 0);
    nodes.push({
      file: rootId, community: rootComm, communityLabel,
      degree: Math.max(3, hubCount * 2), symbolCount: hubCount,
    });
    const sections: ParsedSection[] = [
      ...(parsed.preamble.length > 0 ? [{ heading: "Notes", facts: parsed.preamble }] : []),
      ...parsed.sections,
    ];
    for (const sec of sections) {
      const secComm = community++;
      const hubId = uniq(sec.heading);
      nodes.push({
        file: hubId, community: secComm, communityLabel: sec.heading,
        degree: sec.facts.length + 1, symbolCount: sec.facts.length,
      });
      edges.push({ a: rootId, b: hubId, w: 3 });
      for (const fact of sec.facts) {
        const factId = uniq(fact);
        nodes.push({ file: factId, community: secComm, communityLabel: sec.heading, degree: 1, symbolCount: 0 });
        edges.push({ a: hubId, b: factId, w: 1 });
      }
    }
  };

  addRoot("You", "you", user);
  addRoot(input.projectName, "project", proj);

  return { projectName: `${input.projectName} — what your agent knows`, nodes, edges, showLabels: true };
}
