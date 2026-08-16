/**
 * Symbol → line-span resolution for the graph-aware read tool (G5). Pure,
 * vscode-free; mirrored in the CLI.
 *
 * read(path, symbol="login") serves exactly the symbol's span instead of the
 * model doing file_outline → read offset/limit — one round trip instead of
 * two, and a full agent round trip is the expensive unit (assistant turn +
 * tool turn + resend), not the lines.
 */

export interface SpanSymbol {
  name: string
  kind: string
  /** start line, 1-based (LocalSymbol.line). */
  line: number
  end_line?: number | null
}

export interface ResolvedSpan {
  name: string
  kind: string
  start: number
  end: number
}

/** Lines of context served either side of the resolved span. */
export const SPAN_MARGIN = 5

/** Fallback span length when the extractor recorded no end line. */
const DEFAULT_SPAN_LINES = 60

/**
 * Resolve `query` against a file's symbols. Match order: exact name →
 * `Class.method` dotted suffix → case-insensitive. Ties go to the earliest
 * definition. Returns null when nothing matches — the caller answers with the
 * outline so the model recovers in one step instead of guessing offsets.
 */
export function resolveSymbolSpan(symbols: SpanSymbol[], query: string): ResolvedSpan | null {
  const q = query.trim()
  if (!q || symbols.length === 0) return null
  const dotted = q.includes('.') ? q.slice(q.lastIndexOf('.') + 1) : null

  const pick = (pred: (s: SpanSymbol) => boolean): SpanSymbol | null => {
    const hits = symbols.filter(pred)
    if (hits.length === 0) return null
    return hits.reduce((a, b) => (b.line < a.line ? b : a))
  }

  const found =
    pick((s) => s.name === q) ??
    (dotted ? pick((s) => s.name === dotted) : null) ??
    pick((s) => s.name.toLowerCase() === q.toLowerCase())
  if (!found) return null

  const end = found.end_line && found.end_line >= found.line
    ? found.end_line
    : found.line + DEFAULT_SPAN_LINES - 1
  return { name: found.name, kind: found.kind, start: found.line, end }
}

/** The not-found reply: the outline, so the next call is right. */
export function symbolNotFoundNotice(relPath: string, query: string, symbols: SpanSymbol[]): string {
  if (symbols.length === 0) {
    return (
      `No symbol "${query}" — ${relPath} is not in the code graph yet (indexing may be ` +
      `in progress). Use offset/limit to read it directly.`
    )
  }
  const listing = symbols
    .slice(0, 40)
    .map((s) => `${s.line}: ${s.name} (${s.kind})`)
    .join('\n')
  return (
    `No symbol "${query}" in ${relPath}. Symbols present:\n${listing}` +
    (symbols.length > 40 ? `\n[... ${symbols.length - 40} more]` : '') +
    `\nCall read again with one of these names, or offset/limit.`
  )
}
