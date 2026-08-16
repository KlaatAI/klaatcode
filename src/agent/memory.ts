/**
 * M1 — cross-session memory: the "code buddy" layer.
 *
 * Two capped markdown files hold what the agent has LEARNED about this user,
 * distilled by a cheap fast-tier call every few turns (background, never
 * blocking) and injected once at session start into the stable system block —
 * so memory is prefix-cache-safe (G2 law: nothing mutates the prompt head
 * mid-session; learnings land in the NEXT session's prompt).
 *
 *   ~/.klaatai/memory/<project-id>.md  — how THIS project is worked on:
 *       commands that actually ran, conventions, decisions, corrections.
 *   ~/.klaatai/memory/user.md          — who the user is across projects:
 *       tone, verbosity, review style, recurring tools.
 *
 * The distiller learns hardest from friction — user corrections, reverted
 * edits, repeated instructions — which is the same signal family the W-track
 * telemetry treats as ground truth. It UPDATES the files (merge, rewrite,
 * drop disproven facts) rather than appending forever; the caps force
 * selection pressure, which is what keeps old wrong facts from surviving.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveProjectId } from "../utils/project-id.js";

export const MEMORY_DIR = join(homedir(), ".klaatai", "memory");

/** ~2K tokens — enough for real knowledge, small enough to force curation. */
export const PROJECT_MEMORY_MAX_CHARS = 8_000;
/** ~500 tokens — cross-project preferences are few by nature. */
export const USER_MEMORY_MAX_CHARS = 2_000;

/** Distill when this many user turns have accumulated since the last pass. */
export const DISTILL_EVERY_USER_TURNS = 6;

export function userMemoryPath(): string {
  return join(MEMORY_DIR, "user.md");
}

export function projectMemoryPath(projectId: string): string {
  return join(MEMORY_DIR, `${projectId}.md`);
}

function _readCapped(path: string, cap: number): string {
  try {
    if (!existsSync(path)) return "";
    return readFileSync(path, "utf-8").slice(0, cap).trim();
  } catch { return ""; }
}

export interface LoadedMemory {
  project: string;
  user: string;
  projectId: string | null;
}

export function loadMemory(projectRoot: string): LoadedMemory {
  const proj = resolveProjectId(projectRoot);
  return {
    projectId: proj?.id ?? null,
    project: proj ? _readCapped(projectMemoryPath(proj.id), PROJECT_MEMORY_MAX_CHARS) : "",
    user: _readCapped(userMemoryPath(), USER_MEMORY_MAX_CHARS),
  };
}

/** The system-prompt block. Loaded ONCE at session start — never re-read
 *  mid-session (prefix-cache stability). Null when nothing is known yet. */
export function memorySystemBlock(projectRoot: string): string | null {
  const mem = loadMemory(projectRoot);
  if (!mem.project && !mem.user) return null;
  const parts = ["# Memory — learned from this user's previous sessions. Trust it: it reflects what they actually do, not defaults."];
  if (mem.project) parts.push(`## This project\n${mem.project}`);
  if (mem.user) parts.push(`## This user\n${mem.user}`);
  parts.push(
    "Apply silently — do not recite this memory back or say \"I remember\". " +
    "Anything under Corrections is a mistake the user already had to fix once; repeating one is the worst failure available to you.",
  );
  return parts.join("\n\n");
}

export function writeProjectMemory(projectId: string, content: string): void {
  mkdirSync(MEMORY_DIR, { recursive: true });
  writeFileSync(projectMemoryPath(projectId), content.slice(0, PROJECT_MEMORY_MAX_CHARS).trim() + "\n", "utf-8");
}

export function writeUserMemory(content: string): void {
  mkdirSync(MEMORY_DIR, { recursive: true });
  writeFileSync(userMemoryPath(), content.slice(0, USER_MEMORY_MAX_CHARS).trim() + "\n", "utf-8");
}

export function clearMemory(projectRoot: string, scope: "project" | "user" | "all"): string[] {
  const cleared: string[] = [];
  const proj = resolveProjectId(projectRoot);
  const tryClear = (p: string) => {
    try { if (existsSync(p)) { writeFileSync(p, "", "utf-8"); cleared.push(p); } } catch { /* ignore */ }
  };
  if ((scope === "project" || scope === "all") && proj) tryClear(projectMemoryPath(proj.id));
  if (scope === "user" || scope === "all") tryClear(userMemoryPath());
  return cleared;
}

// ─── Distillation ─────────────────────────────────────────────────────────────

const DISTILL_SYSTEM_PROMPT = `You maintain an AI coding agent's long-term memory of one user and one project. You receive the CURRENT memory files and the tail of a live session. Output the UPDATED memory files.

What belongs in PROJECT memory (the "how we work here" file):
- Commands: build/test/run/deploy invocations that actually succeeded in sessions (with their working directory if not the root).
- Conventions: how code is written HERE — naming, file placement, test style, formatting, libraries preferred or banned. Only what you have EVIDENCE for.
- Decisions: choices made with their why ("uses X not Y because Z").
- Corrections: things the user fixed, rejected, or re-asked — each one is a mistake the agent must not repeat. This is the most valuable section.
- Context: deploy targets, environments, related repos.

What belongs in USER memory (stable across all projects):
- Communication preferences (verbosity, language, tone), review habits, risk appetite, recurring tools. NEVER personal data beyond working style.

Rules:
- Durable facts only — skip anything about the current task's specifics that will be stale next session.
- Learn hardest from friction: corrections, reverted edits, repeated instructions outrank everything else.
- UPDATE, do not append: merge duplicates, rewrite stale facts, DELETE disproven ones. If the session contradicts a stored fact, the session wins.
- Terse bullet lines, grouped under the headings above. Project file ≤ 60 lines, user file ≤ 15 lines.
- No commentary, no code fences. Output EXACTLY this shape:

<project_memory>
(updated project memory, or the original unchanged if nothing new)
</project_memory>
<user_memory>
(updated user memory, or the original unchanged if nothing new)
</user_memory>`;

export interface DistillInput {
  existingProject: string;
  existingUser: string;
  /** Flattened recent conversation: "user: ...\nassistant: ..." lines. */
  transcriptTail: string;
  /** Relative paths the agent modified this session (edit friction context). */
  modifiedFiles: string[];
}

export function buildDistillationMessages(
  input: DistillInput,
): Array<{ role: "system" | "user"; content: string }> {
  const user = [
    "<current_project_memory>",
    input.existingProject || "(empty)",
    "</current_project_memory>",
    "",
    "<current_user_memory>",
    input.existingUser || "(empty)",
    "</current_user_memory>",
    "",
    input.modifiedFiles.length > 0
      ? `Files the agent modified this session: ${input.modifiedFiles.slice(0, 30).join(", ")}`
      : "No files were modified this session.",
    "",
    "<session_transcript_tail>",
    input.transcriptTail,
    "</session_transcript_tail>",
  ].join("\n");
  return [
    { role: "system", content: DISTILL_SYSTEM_PROMPT },
    { role: "user", content: user },
  ];
}

export interface DistillResult {
  project: string;
  user: string;
}

/** Parse the distiller's tagged output. Null = malformed → keep old memory. */
export function parseDistillation(text: string): DistillResult | null {
  const proj = /<project_memory>([\s\S]*?)<\/project_memory>/.exec(text);
  const user = /<user_memory>([\s\S]*?)<\/user_memory>/.exec(text);
  if (!proj || !user) return null;
  const clean = (s: string) => s.replace(/^\s*\(empty\)\s*$/m, "").trim();
  return { project: clean(proj[1]!), user: clean(user[1]!) };
}

/** Flatten the recent conversation for the distiller: text turns only,
 *  clipped per message, capped overall so the distill call stays cheap. */
export function flattenTranscriptTail(
  messages: Array<{ role: string; content: unknown }>,
  maxMessages = 40,
  maxCharsPerMessage = 600,
  maxTotalChars = 16_000,
): string {
  const lines: string[] = [];
  let total = 0;
  for (const m of messages.slice(-maxMessages)) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const text = typeof m.content === "string" ? m.content : "";
    if (!text.trim()) continue;
    const clipped = text.length > maxCharsPerMessage
      ? text.slice(0, maxCharsPerMessage) + " […]"
      : text;
    const line = `${m.role}: ${clipped}`;
    total += line.length;
    if (total > maxTotalChars) break;
    lines.push(line);
  }
  return lines.join("\n");
}
