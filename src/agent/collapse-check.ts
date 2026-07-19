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
