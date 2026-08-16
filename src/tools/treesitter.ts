/**
 * Tree-sitter AST parsing for the code graph — exact spans, methods, and nested
 * symbols (a precision upgrade over the regex extractor). Mirrors
 * KlaatAI.VSCode/src/tools/treesitter.ts; keep symbol maps in sync.
 *
 * FAIL SOFT by design: grammars resolve out of node_modules at runtime
 * (web-tree-sitter core + tree-sitter-wasms grammar pack — no copy step, unlike
 * VS Code's out/wasm). In a `bun build --compile` binary node_modules doesn't
 * exist, resolution throws, and every function returns null/false — the indexer
 * silently keeps using the regex extractor; behaviour is never worse than before.
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { SymKind, ExtractedSymbol } from "./regex-symbols.js";

// web-tree-sitter is loaded lazily; types kept loose to avoid API coupling.
let Parser: any = null;
let Language: any = null;
let initialized = false;
let initFailed = false;
let wasmGrammarDir = "";
const parsers = new Map<string, any>();

interface LangSpec {
  grammar: string;                          // tree-sitter-<grammar>.wasm
  symbols: Record<string, SymKind>;         // AST node type → symbol kind
}

const TS_SYMS: Record<string, SymKind> = {
  function_declaration: "function",
  generator_function_declaration: "function",
  class_declaration: "class",
  abstract_class_declaration: "class",
  interface_declaration: "interface",
  type_alias_declaration: "type",
  enum_declaration: "enum",
  method_definition: "method",
};

// Keyed by file extension.
const LANGS: Record<string, LangSpec> = {
  ts: { grammar: "typescript", symbols: TS_SYMS },
  mts: { grammar: "typescript", symbols: TS_SYMS },
  cts: { grammar: "typescript", symbols: TS_SYMS },
  tsx: { grammar: "tsx", symbols: TS_SYMS },
  js: { grammar: "javascript", symbols: TS_SYMS },
  jsx: { grammar: "javascript", symbols: TS_SYMS },
  mjs: { grammar: "javascript", symbols: TS_SYMS },
  cjs: { grammar: "javascript", symbols: TS_SYMS },
  py: { grammar: "python", symbols: { function_definition: "function", class_definition: "class" } },
  go: { grammar: "go", symbols: { function_declaration: "function", method_declaration: "method", type_spec: "type" } },
  rs: { grammar: "rust", symbols: { function_item: "function", struct_item: "class", enum_item: "enum", trait_item: "interface" } },
  java: { grammar: "java", symbols: { class_declaration: "class", interface_declaration: "interface", enum_declaration: "enum", record_declaration: "class", method_declaration: "method" } },
  cs: { grammar: "c_sharp", symbols: { class_declaration: "class", interface_declaration: "interface", enum_declaration: "enum", struct_declaration: "class", record_declaration: "class", method_declaration: "method" } },
  kt: { grammar: "kotlin", symbols: { class_declaration: "class", object_declaration: "class", function_declaration: "function" } },
  kts: { grammar: "kotlin", symbols: { class_declaration: "class", object_declaration: "class", function_declaration: "function" } },
  rb: { grammar: "ruby", symbols: { class: "class", module: "interface", method: "method", singleton_method: "method" } },
  php: { grammar: "php", symbols: { class_declaration: "class", interface_declaration: "interface", trait_declaration: "class", enum_declaration: "enum", function_definition: "function", method_declaration: "method" } },
  swift: { grammar: "swift", symbols: { class_declaration: "class", protocol_declaration: "interface", function_declaration: "function" } },
  c:     { grammar: "c",     symbols: { function_definition: "function", struct_specifier: "class", enum_specifier: "enum" } },
  h:     { grammar: "c",     symbols: { function_definition: "function", struct_specifier: "class", enum_specifier: "enum" } },
  cc:    { grammar: "cpp",   symbols: { function_definition: "function", class_specifier: "class", struct_specifier: "class", enum_specifier: "enum" } },
  cpp:   { grammar: "cpp",   symbols: { function_definition: "function", class_specifier: "class", struct_specifier: "class", enum_specifier: "enum" } },
  cxx:   { grammar: "cpp",   symbols: { function_definition: "function", class_specifier: "class", struct_specifier: "class", enum_specifier: "enum" } },
  hpp:   { grammar: "cpp",   symbols: { function_definition: "function", class_specifier: "class", struct_specifier: "class" } },
  dart:  { grammar: "dart",  symbols: { class_definition: "class", function_signature: "function", method_signature: "method" } },
  lua:   { grammar: "lua",   symbols: { function_definition: "function", local_function: "function" } },
  scala: { grammar: "scala", symbols: { class_definition: "class", object_definition: "class", function_definition: "function" } },
  sh:    { grammar: "bash",  symbols: { function_definition: "function" } },
  bash:  { grammar: "bash",  symbols: { function_definition: "function" } },
};

const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

/** Best-effort callee identifier from a call-ish node (works across grammars). */
function calleeName(node: any): string | null {
  const fn = node.childForFieldName?.("function") ?? node.childForFieldName?.("name") ?? node.firstChild;
  if (!fn) return null;
  let target = fn;
  for (let i = 0; i < 4; i++) {
    const prop =
      target.childForFieldName?.("property") ??
      target.childForFieldName?.("name") ??
      target.childForFieldName?.("field") ??
      target.childForFieldName?.("attribute");
    if (!prop) break;
    target = prop;
  }
  const text: string = (target.text ?? "").trim();
  return IDENT_RE.test(text) ? text : null;
}

export interface TsParseResult {
  symbols: ExtractedSymbol[];
  /** caller symbol name → callee names found in its body (for kg_edges). */
  calls: Record<string, string[]>;
}

/** One-time init of the wasm runtime. Returns false (permanently) on failure. */
export async function initTreeSitter(): Promise<boolean> {
  if (initialized) return true;
  if (initFailed) return false;
  try {
    const req = createRequire(import.meta.url);
    // Resolves against node_modules wherever this package is installed; throws
    // inside a --compile binary → permanent regex fallback.
    const coreDir = dirname(req.resolve("web-tree-sitter/package.json"));
    wasmGrammarDir = join(dirname(req.resolve("tree-sitter-wasms/package.json")), "out");
    const TS: any = await import("web-tree-sitter");
    Parser = TS.Parser ?? TS.default?.Parser ?? TS.default;
    Language = TS.Language ?? TS.default?.Language;
    if (!Parser || !Language) throw new Error("web-tree-sitter API not found");
    await Parser.init({ locateFile: (name: string) => join(coreDir, name) });
    initialized = true;
    return true;
  } catch {
    initFailed = true;
    return false;
  }
}

async function getParser(ext: string): Promise<any | null> {
  if (!initialized || !LANGS[ext]) return null;
  if (parsers.has(ext)) return parsers.get(ext); // may be null (prior failure)
  try {
    const bytes = await readFile(join(wasmGrammarDir, `tree-sitter-${LANGS[ext]!.grammar}.wasm`));
    const lang = await Language.load(new Uint8Array(bytes));
    const parser = new Parser();
    parser.setLanguage(lang);
    parsers.set(ext, parser);
    return parser;
  } catch {
    parsers.set(ext, null);
    return null;
  }
}

function isExported(ext: string, name: string, lineText: string): boolean {
  if (["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"].includes(ext)) return /\bexport\b/.test(lineText);
  if (ext === "py" || ext === "rb") return !name.startsWith("_");
  if (ext === "go") return /^[A-Z]/.test(name);
  if (ext === "rs") return /\bpub\b/.test(lineText);
  if (ext === "cs" || ext === "java") return /\b(public|protected)\b/.test(lineText);
  if (ext === "kt" || ext === "kts" || ext === "swift") return !/\b(private|fileprivate|internal)\b/.test(lineText);
  if (ext === "php") return !/\bprivate\b/.test(lineText);
  if (["c", "cc", "cpp", "cxx", "h", "hpp"].includes(ext)) return !/\bstatic\b/.test(lineText);
  if (ext === "dart") return !name.startsWith("_");
  if (ext === "scala") return !/\b(private|protected)\b/.test(lineText);
  return true;
}

/** Parse one file with tree-sitter. Returns null when unavailable for `ext`. */
export async function parseWithTreeSitter(ext: string, source: string): Promise<TsParseResult | null> {
  const parser = await getParser(ext);
  if (!parser) return null;
  try {
    const tree = parser.parse(source);
    if (!tree) return null;
    const spec = LANGS[ext]!;
    const lines = source.split("\n");
    const out: ExtractedSymbol[] = [];
    const calls: Record<string, string[]> = {};

    const visit = (node: any, enclosing: string | null) => {
      const kind = spec.symbols[node.type];
      let symbolName: string | null = null;
      if (kind) {
        const nameNode = node.childForFieldName?.("name");
        const name: string = (nameNode?.text ?? "").trim();
        if (name && IDENT_RE.test(name)) {
          symbolName = name;
          const lineText = lines[node.startPosition.row] ?? "";
          out.push({
            name,
            kind,
            signature: lineText.trim().slice(0, 200),
            start_line: node.startPosition.row + 1,
            end_line: node.endPosition.row + 1,   // exact span — no brace counting
            is_exported: isExported(ext, name, lineText),
          });
        }
      }
      // Detect: const/let/var foo = () => {} or const/let/var foo = function() {}
      if (!symbolName && node.type === "variable_declarator") {
        const valueNode = node.childForFieldName?.("value");
        if (valueNode && (valueNode.type === "arrow_function" || valueNode.type === "function_expression")) {
          const nameNode = node.childForFieldName?.("name");
          const name: string = (nameNode?.text ?? "").trim();
          if (name && IDENT_RE.test(name)) {
            symbolName = name;
            const lineText = lines[node.startPosition.row] ?? "";
            out.push({
              name,
              kind: "function",
              signature: lineText.trim().slice(0, 200),
              start_line: node.startPosition.row + 1,
              end_line: valueNode.endPosition.row + 1,
              is_exported: isExported(ext, name, lineText),
            });
          }
        }
      }

      // Attribute call-ish nodes to the innermost enclosing symbol → kg_edges.
      const owner = symbolName ?? enclosing;
      if (owner && (node.type.includes("call") || node.type.includes("invocation"))) {
        const callee = calleeName(node);
        if (callee && callee !== owner) {
          const list = (calls[owner] ??= []);
          if (list.length < 60 && !list.includes(callee)) list.push(callee);
        }
      }
      for (let i = 0; i < node.namedChildCount; i++) visit(node.namedChild(i), owner);
    };

    visit(tree.rootNode, null);
    tree.delete?.();
    return out.length > 0 ? { symbols: out, calls } : null;
  } catch {
    return null;
  }
}
