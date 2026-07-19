/**
 * Exploration planner — "query optimizer for code" (roadmap 9.2).
 *
 * Given a task description, produce an ordered file-read plan from the local
 * code graph BEFORE the agent starts reading: which files matter, in what
 * order, and how deeply to read each (outline vs targeted section vs full
 * read). Saves the read-everything-in-random-order token burn that dominates
 * multi-file tasks.
 *
 * Pure logic with injectable graph accessors so it unit-tests without a
 * SQLite index. Wiring lives in tools/index.ts (plan_exploration tool).
 */

export interface PlanStep {
  file: string;
  mode: "outline" | "section" | "read";
  rationale: string;
  /** Line to center a section read on (mode "section" only). */
  line?: number;
}

export interface GraphAccess {
  /** Symbol search (name/path LIKE) — localDbQuery shape. */
  query(keyword: string, limit: number): Array<{
    name: string; kind: string; file: string; line: number;
  }>;
  /** 1-hop callers of a symbol — localDbCallers shape. */
  callers(symbolName: string): Array<{ callerName: string; callerFile: string; hop: number }>;
}

// ─── Keyword extraction ──────────────────────────────────────────────────────

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "when", "where",
  "what", "make", "add", "fix", "bug", "issue", "implement", "change", "update",
  "create", "remove", "delete", "refactor", "should", "would", "could", "then",
  "also", "have", "will", "does", "doesn", "don", "file", "files", "code",
  "function", "method", "class", "test", "tests", "error", "check", "there",
  "please", "need", "want", "like", "some", "more", "less", "very", "just",
]);

/** Pull searchable identifiers/paths out of a natural-language task. */
export function extractKeywords(task: string): { paths: string[]; terms: string[] } {
  const paths = new Set<string>();
  const terms = new Set<string>();

  // Quoted/backticked spans are high-signal verbatim identifiers or paths.
  for (const m of task.matchAll(/[`'"]([^`'"\n]{2,80})[`'"]/g)) {
    const v = m[1]!.trim();
    if (/[/\\]|\.[a-z]{1,5}$/i.test(v)) paths.add(v);
    else if (/^[\w.-]+$/.test(v)) terms.add(v);
  }

  // Bare path-looking tokens (contain / or a source-file extension).
  for (const m of task.matchAll(/(?<![\w/])((?:[\w.-]+\/)+[\w.-]+|[\w-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|rb|cs|cpp|c|h|md|json|yaml|yml|toml))(?![\w/])/g)) {
    paths.add(m[1]!);
  }

  // Identifier-shaped words: camelCase, snake_case, PascalCase, dotted.
  for (const m of task.matchAll(/\b([a-zA-Z_][\w]{3,})\b/g)) {
    const w = m[1]!;
    if (STOPWORDS.has(w.toLowerCase())) continue;
    const identifierish = /[a-z][A-Z]/.test(w) || w.includes("_") || /^[A-Z][a-z]+[A-Z]/.test(w);
    if (identifierish) terms.add(w);
    else if (w.length >= 5) terms.add(w); // plain long words still worth a graph probe
  }

  return { paths: [...paths].slice(0, 8), terms: [...terms].slice(0, 10) };
}

// ─── Plan assembly ───────────────────────────────────────────────────────────

const DEFAULT_MAX_FILES = 8;

/**
 * Build the ordered plan. Order: files named in the task (read) → files
 * defining matched symbols (section, centered on the symbol) → 1-hop caller
 * files (outline — blast-radius awareness before editing).
 */
export function buildPlan(
  task: string,
  graph: GraphAccess,
  maxFiles = DEFAULT_MAX_FILES,
): PlanStep[] {
  const { paths, terms } = extractKeywords(task);
  const steps: PlanStep[] = [];
  const seen = new Set<string>();
  const push = (s: PlanStep): void => {
    if (seen.has(s.file) || steps.length >= maxFiles) return;
    seen.add(s.file);
    steps.push(s);
  };

  // 1. Files the user named explicitly — read them properly.
  for (const p of paths) push({ file: p, mode: "read", rationale: "named in the task" });

  // 2. Graph symbol hits — go straight to the defining section.
  const matchedSymbols: Array<{ name: string; file: string }> = [];
  for (const term of terms) {
    for (const sym of graph.query(term, 3)) {
      matchedSymbols.push({ name: sym.name, file: sym.file });
      push({
        file: sym.file,
        mode: "section",
        line: sym.line,
        rationale: `defines ${sym.kind} \`${sym.name}\` (matched "${term}")`,
      });
    }
  }

  // 3. Callers of the strongest hits — outline only (blast radius, not depth).
  for (const sym of matchedSymbols.slice(0, 3)) {
    for (const c of graph.callers(sym.name)) {
      if (c.hop > 1) continue;
      push({ file: c.callerFile, mode: "outline", rationale: `calls \`${sym.name}\`` });
    }
  }

  return steps;
}

/** Render the plan as the tool result the model consumes. */
export function renderPlan(task: string, steps: PlanStep[]): string {
  if (steps.length === 0) {
    return (
      "No exploration plan could be derived from the code graph for this task. " +
      "Fall back to project_graph_query / grep for discovery — indexing runs " +
      "automatically at TUI startup and may still be in progress."
    );
  }
  const lines = [
    `Exploration plan (${steps.length} files, in order — follow it instead of ad-hoc reading):`,
    "",
  ];
  steps.forEach((s, i) => {
    const how =
      s.mode === "outline" ? "file_outline" :
      s.mode === "section"  ? `read_file offset≈${Math.max(1, (s.line ?? 1) - 20)} limit≈60` :
      "read_file";
    lines.push(`${i + 1}. ${s.file} — ${s.mode} (${how}) · ${s.rationale}`);
  });
  lines.push(
    "",
    "Guidance: outline before reading; read only the listed sections first; " +
    "widen with read_file offset/limit only when a section proves insufficient. " +
    "Check impact_check before editing any symbol with callers.",
  );
  return lines.join("\n");
}
