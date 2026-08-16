/**
 * G4b — markdown doc-chunk extraction.
 *
 * Markdown files enter the graph as files whose "symbols" are heading
 * sections (kind: "section"). That makes docs reachable through the same
 * paths as code: file_outline gives the heading tree, project_graph_query
 * matches heading names, and semantic search embeds each section — so
 * "where is deployment documented?" resolves without grepping the docs tree.
 *
 * Deliberately regex-based: headings are line-anchored, so a real markdown
 * parser buys nothing here. Fenced code blocks are skipped so a `# comment`
 * inside a ```sh block is not a heading.
 */

import type { ExtractedSymbol } from "./regex-symbols.js";

const MAX_SECTIONS = 100;
/** First content line is folded into the signature — it is what gets embedded. */
const MAX_SIG_CHARS = 200;

export function extractDocSections(text: string, fileBaseName: string): ExtractedSymbol[] {
  const lines = text.split("\n");

  interface Heading { level: number; title: string; line: number } // line is 1-based
  const headings: Heading[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (/^\s*(```|~~~)/.test(l)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l);
    if (m) headings.push({ level: m[1]!.length, title: m[2]!.trim(), line: i + 1 });
    if (headings.length >= MAX_SECTIONS) break;
  }

  // A doc with no headings still deserves one node (LICENSE-style files,
  // short notes) — otherwise it is invisible to the graph entirely.
  if (headings.length === 0) {
    if (lines.every((l) => l.trim() === "")) return [];
    return [{
      name: fileBaseName,
      kind: "section",
      signature: firstContentLine(lines, 0, lines.length),
      start_line: 1,
      end_line: lines.length,
      is_exported: true,
    }];
  }

  const out: ExtractedSymbol[] = [];
  for (let h = 0; h < headings.length; h++) {
    const cur = headings[h]!;
    // Section ends where the next heading of the same-or-higher level starts.
    let end = lines.length;
    for (let j = h + 1; j < headings.length; j++) {
      if (headings[j]!.level <= cur.level) { end = headings[j]!.line - 1; break; }
    }
    const lead = firstContentLine(lines, cur.line, end);
    out.push({
      name: cur.title,
      kind: "section",
      signature: (`${"#".repeat(cur.level)} ${cur.title}` + (lead ? ` — ${lead}` : "")).slice(0, MAX_SIG_CHARS),
      start_line: cur.line,
      end_line: end,
      // Top-two heading levels are the document's main structure.
      is_exported: cur.level <= 2,
    });
  }
  return out;
}

/** First non-blank, non-heading, non-fence line in [startLine, endLine) (0-based scan from startLine). */
function firstContentLine(lines: string[], startLine: number, endLine: number): string {
  for (let i = startLine; i < Math.min(endLine, lines.length); i++) {
    const t = (lines[i] ?? "").trim();
    if (t === "" || t.startsWith("#") || t.startsWith("```") || t.startsWith("~~~")) continue;
    return t.slice(0, MAX_SIG_CHARS);
  }
  return "";
}
