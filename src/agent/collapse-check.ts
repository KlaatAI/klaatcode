/**
 * Context-collapse detection (roadmap 9.6).
 *
 * Compaction is lossy and silent: the agent "can't tell you it's forgotten
 * something, because it doesn't know it forgot". This module makes the loss
 * detectable:
 *
 *   1. collectCriticalState() — BEFORE compaction, snapshot what must survive:
 *      the task intent (the user's own words) and the files being worked on.
 *   2. checkSummaryCoverage() — AFTER compaction, mechanically verify the
 *      summary still carries those items; anything missing is reported so the
 *      caller can inject a recovery note pointing at the session ledger.
 *
 * Both are pure and deterministic — zero LLM cost.
 */

import type { Message } from "../api/client.js";

export interface CriticalState {
  /** The user's task in their own words (latest substantial user message). */
  taskIntent: string | null;
  /** Files modified this session — the work product must not be forgotten. */
  files: string[];
}

const INTENT_STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "then", "also",
  "have", "will", "would", "could", "should", "please", "just", "make", "want",
  "need", "like", "some", "when", "what", "where", "there", "them", "were",
]);

/** Significant words of a text — the terms a faithful summary would retain. */
function significantWords(text: string): string[] {
  return [...new Set(
    (text.toLowerCase().match(/[a-z_][\w.-]{3,}/g) ?? [])
      .filter(w => !INTENT_STOPWORDS.has(w)),
  )];
}

/**
 * Snapshot critical state from the span about to be summarized.
 * Task intent = the last user message of real length (short follow-ups like
 * "yes" or "continue" don't define the task).
 */
export function collectCriticalState(span: Message[], modifiedFiles: string[]): CriticalState {
  let taskIntent: string | null = null;
  for (let i = span.length - 1; i >= 0; i--) {
    const m = span[i]!;
    if (m.role !== "user" || typeof m.content !== "string") continue;
    const text = m.content.trim();
    if (text.startsWith("[tool result]")) continue; // flattened tool noise
    if (text.length >= 30) { taskIntent = text.slice(0, 500); break; }
    if (taskIntent === null) taskIntent = text.slice(0, 500); // fallback: any user msg
  }
  return { taskIntent, files: [...new Set(modifiedFiles)].slice(0, 20) };
}

// ─── M3: cumulative file-op tracking across compactions ─────────────────────
// prime-agent finding: each compaction summary must carry forward the file
// lists from PRIOR summaries, or after 2-3 compactions the model no longer
// knows which files it touched early in the session. The list rides inside
// the summary stub itself (a marker line), so it survives any number of
// compactions without extra session state.

const CUMULATIVE_FILES_RE = /Cumulative files touched[^:]*:\s*([^\n]+)/;
const CUMULATIVE_FILES_CAP = 40;

/** Every file named in a tool call's path argument within a span — reads AND
 * writes; knowing what was already read prevents pointless re-exploration. */
export function collectTouchedFiles(span: Message[]): string[] {
  const files = new Set<string>();
  for (const m of span) {
    if (m.role !== "assistant" || !m.tool_calls) continue;
    for (const tc of m.tool_calls) {
      try {
        const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        for (const key of ["path", "file_path", "filePath"]) {
          const v = args[key];
          if (typeof v === "string" && v.trim()) { files.add(v.trim()); break; }
        }
      } catch { /* malformed args — skip */ }
    }
  }
  return [...files];
}

/** Recover the carried-forward list from a prior compaction stub in the span. */
export function parsePriorCumulativeFiles(span: Message[]): string[] {
  const files: string[] = [];
  for (const m of span) {
    const c = typeof m.content === "string" ? m.content : "";
    const match = CUMULATIVE_FILES_RE.exec(c);
    if (!match) continue;
    for (const f of match[1]!.split(/,\s*/)) if (f.trim()) files.push(f.trim());
  }
  return files;
}

/**
 * The marker line appended to each new compaction stub: prior list (parsed
 * from any earlier stub in the span) + files touched in this span + files
 * modified this session. Over the cap, the OLDEST entries drop first — recent
 * work matters more. Null when the session touched nothing.
 */
export function buildCumulativeFilesLine(span: Message[], modifiedFiles: string[]): string | null {
  const merged = [...new Set([
    ...parsePriorCumulativeFiles(span),
    ...collectTouchedFiles(span),
    ...modifiedFiles,
  ])];
  if (merged.length === 0) return null;
  return `Cumulative files touched (all context, carried across compactions): ${merged.slice(-CUMULATIVE_FILES_CAP).join(", ")}`;
}

const INTENT_COVERAGE_MIN = 0.4; // ≥40% of significant task words must survive

/**
 * Verify a compaction summary still covers the critical state.
 * Returns human-readable descriptions of what appears to be MISSING
 * (empty array = no collapse detected).
 */
export function checkSummaryCoverage(summary: string, state: CriticalState): string[] {
  const missing: string[] = [];
  const lower = summary.toLowerCase();

  if (state.taskIntent) {
    const words = significantWords(state.taskIntent);
    if (words.length > 0) {
      const kept = words.filter(w => lower.includes(w)).length;
      if (kept / words.length < INTENT_COVERAGE_MIN) {
        missing.push(`the task intent ("${state.taskIntent.slice(0, 80)}…")`);
      }
    }
  }

  const lost = state.files.filter(f => {
    const base = f.split("/").pop() ?? f;
    return !lower.includes(base.toLowerCase());
  });
  if (lost.length > 0) {
    missing.push(`modified file${lost.length > 1 ? "s" : ""} ${lost.slice(0, 5).join(", ")}`);
  }

  return missing;
}
