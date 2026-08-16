/**
 * Language-aware regex symbol extraction — no language server, no wasm.
 * Fast enough for background indexing; tree-sitter upgrade is optional later.
 */

export type SymKind = "function" | "method" | "class" | "interface" | "type" | "enum" | "variable" | "other" | "section";

export interface ExtractedSymbol {
  name: string;
  kind: SymKind;
  signature: string;
  start_line: number;   // 1-based
  end_line: number;     // 1-based
  is_exported: boolean;
}

const TS_EXT = new Set(["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs", "vue", "svelte"]);

function blockEnd(lines: string[], i: number): number {
  let depth = 0;
  for (let j = i; j < Math.min(i + 400, lines.length); j++) {
    const l = lines[j] ?? "";
    depth += (l.match(/\{/g)?.length ?? 0) - (l.match(/\}/g)?.length ?? 0);
    if (j > i && depth <= 0) return j + 1;
  }
  return i + 1;
}

function push(out: ExtractedSymbol[], s: ExtractedSymbol): void {
  if (s.name && /^[A-Za-z_$][\w$]*$/.test(s.name)) out.push(s);
}

function extractTs(lines: string[]): ExtractedSymbol[] {
  const out: ExtractedSymbol[] = [];
  const pats: { re: RegExp; kind: SymKind; nameGroup: number }[] = [
    { re: /^(export\s+)?(export\s+default\s+)?(abstract\s+)?class\s+(\w+)/, kind: "class", nameGroup: 4 },
    { re: /^(export\s+)?interface\s+(\w+)/, kind: "interface", nameGroup: 2 },
    { re: /^(export\s+)?type\s+(\w+)\s*[=<]/, kind: "type", nameGroup: 2 },
    { re: /^(export\s+)?enum\s+(\w+)/, kind: "enum", nameGroup: 2 },
    { re: /^(export\s+)?(async\s+)?function\s*\*?\s+(\w+)/, kind: "function", nameGroup: 3 },
    { re: /^(export\s+)?(const|let|var)\s+(\w+)\s*=\s*(async\s*)?\(?[^=]*\)?\s*=>/, kind: "function", nameGroup: 3 },
    { re: /^(export\s+)?(const|let|var)\s+(\w+)\s*[:=]/, kind: "variable", nameGroup: 3 },
  ];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const t = raw.trimStart();
    if (!t || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
    for (const { re, kind, nameGroup } of pats) {
      const m = re.exec(t);
      if (!m) continue;
      const name = m[nameGroup] ?? "";
      const exported = t.startsWith("export");
      const sig = (t.includes("{") ? t.slice(0, t.indexOf("{")) : t).trim().slice(0, 200);
      const end = (kind === "class" || kind === "interface" || kind === "enum" || kind === "function") && t.includes("{")
        ? blockEnd(lines, i) : i + 1;
      push(out, { name, kind, signature: sig, start_line: i + 1, end_line: end, is_exported: exported });
      break;
    }
  }
  return out;
}

function extractPython(lines: string[]): ExtractedSymbol[] {
  const out: ExtractedSymbol[] = [];
  const fnRe = /^(\s*)(async\s+)?def\s+(\w+)\s*\(/;
  const clsRe = /^class\s+(\w+)/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fm = fnRe.exec(line);
    if (fm) {
      const indented = (fm[1] ?? "").length > 0;
      const name = fm[3] ?? "";
      push(out, {
        name, kind: indented ? "method" : "function",
        signature: line.trim().slice(0, 200), start_line: i + 1, end_line: i + 1,
        is_exported: !name.startsWith("_"),
      });
      continue;
    }
    const cm = clsRe.exec(line);
    if (cm) push(out, { name: cm[1] ?? "", kind: "class", signature: line.trim().slice(0, 200), start_line: i + 1, end_line: i + 1, is_exported: true });
  }
  return out;
}

function extractByPatterns(
  lines: string[],
  pats: { re: RegExp; kind: SymKind; nameGroup: number }[],
): ExtractedSymbol[] {
  const out: ExtractedSymbol[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = (lines[i] ?? "").trimStart();
    if (!t || t.startsWith("//") || t.startsWith("#") || t.startsWith("*")) continue;
    for (const { re, kind, nameGroup } of pats) {
      const m = re.exec(t);
      if (!m) continue;
      const name = m[nameGroup] ?? "";
      const end = t.includes("{") ? blockEnd(lines, i) : i + 1;
      push(out, {
        name, kind, signature: t.slice(0, 200), start_line: i + 1, end_line: end,
        is_exported: /^[A-Z]/.test(name) || /\bpub\b|\bpublic\b|\bexport\b/.test(t),
      });
      break;
    }
  }
  return out;
}

const GO_PATS = [
  { re: /^func\s+(?:\([^)]*\)\s*)?(\w+)\s*\(/, kind: "function" as SymKind, nameGroup: 1 },
  { re: /^type\s+(\w+)\s+struct\b/, kind: "class" as SymKind, nameGroup: 1 },
  { re: /^type\s+(\w+)\s+interface\b/, kind: "interface" as SymKind, nameGroup: 1 },
  { re: /^type\s+(\w+)\b/, kind: "type" as SymKind, nameGroup: 1 },
];
const RUST_PATS = [
  { re: /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/, kind: "function" as SymKind, nameGroup: 1 },
  { re: /^(?:pub\s+)?struct\s+(\w+)/, kind: "class" as SymKind, nameGroup: 1 },
  { re: /^(?:pub\s+)?enum\s+(\w+)/, kind: "enum" as SymKind, nameGroup: 1 },
  { re: /^(?:pub\s+)?trait\s+(\w+)/, kind: "interface" as SymKind, nameGroup: 1 },
];
const JVM_PATS = [
  { re: /(?:public|private|protected|internal)?\s*(?:abstract\s+|final\s+|sealed\s+)?class\s+(\w+)/, kind: "class" as SymKind, nameGroup: 1 },
  { re: /(?:public|private|protected|internal)?\s*interface\s+(\w+)/, kind: "interface" as SymKind, nameGroup: 1 },
  { re: /(?:public|private|protected|internal)?\s*enum\s+(\w+)/, kind: "enum" as SymKind, nameGroup: 1 },
  { re: /(?:public|private|protected|internal|static|final|async|override|virtual|\s)+[\w<>\[\],.?]+\s+(\w+)\s*\([^;]*\)\s*\{/, kind: "method" as SymKind, nameGroup: 1 },
];
const RUBY_PATS = [
  { re: /^\s*def\s+(self\.)?(\w+)/, kind: "function" as SymKind, nameGroup: 2 },
  { re: /^class\s+(\w+)/, kind: "class" as SymKind, nameGroup: 1 },
  { re: /^module\s+(\w+)/, kind: "class" as SymKind, nameGroup: 1 },
];
const PHP_PATS = [
  { re: /(?:public|protected|private|static|\s)*function\s+(\w+)\s*\(/, kind: "function" as SymKind, nameGroup: 1 },
  { re: /(?:abstract\s+)?class\s+(\w+)/, kind: "class" as SymKind, nameGroup: 1 },
  { re: /interface\s+(\w+)/, kind: "interface" as SymKind, nameGroup: 1 },
];

export function extractSymbols(language: string, ext: string, source: string): ExtractedSymbol[] {
  const lines = source.split("\n");
  if (TS_EXT.has(ext)) return extractTs(lines);
  if (ext === "py") return extractPython(lines);
  if (ext === "go") return extractByPatterns(lines, GO_PATS);
  if (ext === "rs") return extractByPatterns(lines, RUST_PATS);
  if (["java", "kt", "kts", "cs", "scala", "swift"].includes(ext)) return extractByPatterns(lines, JVM_PATS);
  if (ext === "rb") return extractByPatterns(lines, RUBY_PATS);
  if (ext === "php") return extractByPatterns(lines, PHP_PATS);
  return [];
}

// ─── Call-graph edges ──────────────────────────────────────────────────────────
// Regex fallback (same approach as KlaatAI.Code / VSCode when tree-sitter is off):
// within each symbol's body span, find `name(` call sites and attribute them to
// the enclosing symbol. Rough but enough for blast-radius (impact_check).

const CALL_RE = /\b([A-Za-z_$][\w$]*)\s*\(/g;
const NON_CALLS = new Set([
  "if", "for", "while", "switch", "catch", "return", "function", "typeof", "await",
  "new", "super", "class", "do", "else", "throw", "case", "const", "let", "var",
  "import", "require", "in", "of", "instanceof", "void", "delete", "yield", "async",
  "and", "or", "not", "def", "print", "range", "len", "str", "int", "list", "dict",
  "func", "map", "make", "fmt", "match", "when", "unless", "elif", "with", "assert",
]);
const MAX_CALLEES_PER_SYMBOL = 60;
const MAX_EDGES_PER_FILE = 800;

/** Map each symbol name → the names it calls, within its body span. */
export function extractCallEdges(source: string, symbols: ExtractedSymbol[]): Record<string, string[]> {
  const lines = source.split("\n");
  const symNames = new Set(symbols.map(s => s.name));
  const out: Record<string, Set<string>> = {};
  let total = 0;

  for (const sym of symbols) {
    if (total >= MAX_EDGES_PER_FILE) break;
    if (sym.end_line <= sym.start_line) continue; // no real body span
    const body = lines.slice(sym.start_line - 1, sym.end_line).join("\n");
    const callees = out[sym.name] ?? new Set<string>();
    CALL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CALL_RE.exec(body)) !== null) {
      const callee = m[1]!;
      if (callee === sym.name || NON_CALLS.has(callee)) continue;
      // Only keep edges to symbols we actually indexed, or plausible identifiers.
      if (callee.length < 2) continue;
      callees.add(callee);
      if (callees.size >= MAX_CALLEES_PER_SYMBOL) break;
    }
    if (callees.size > 0) { out[sym.name] = callees; total += callees.size; }
    void symNames;
  }
  const result: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(out)) result[k] = [...v];
  return result;
}
