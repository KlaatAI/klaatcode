/**
 * Pure presentation helpers for the REPL — formatting, syntax highlighting,
 * and the rotating status/tip copy. Extracted from repl.ts (Phase 0.3, step 1)
 * so the orchestrator file shrinks; everything here closes over nothing but its
 * arguments and module imports, so it is trivially testable and reusable.
 */

import { span, type Span } from "../engine/index.js";
import { tierLabel, monthlyResetLabel } from "./tiers.js";

/** Cost formatting: enough precision to be honest at sub-cent scale. */
export function fmtUsd(v: number): string {
  return "$" + (v >= 0.1 ? v.toFixed(2) : v >= 0.01 ? v.toFixed(3) : v.toFixed(4));
}

/** "Reading 2 files, running 1 shell command" — aggregate label for the live tool group. */
export function runningPhrase(names: string[]): string {
  const b = { read: 0, edit: 0, cmd: 0, search: 0, agent: 0, web: 0, other: 0 };
  for (const n of names) {
    if (n === "read_file") b.read++;
    else if (["write_file", "edit_file", "multi_edit", "apply_patch"].includes(n)) b.edit++;
    else if (n === "run_command") b.cmd++;
    else if (["grep", "glob", "list_dir", "file_outline", "project_graph_query", "project_semantic_search"].includes(n)) b.search++;
    else if (n === "delegate_task") b.agent++;
    else if (n === "web_fetch" || n === "web_search") b.web++;
    else b.other++;
  }
  const s = (k: number) => (k > 1 ? "s" : "");
  const parts: string[] = [];
  if (b.read)   parts.push(`reading ${b.read} file${s(b.read)}`);
  if (b.edit)   parts.push(`editing ${b.edit} file${s(b.edit)}`);
  if (b.cmd)    parts.push(`running ${b.cmd} shell command${s(b.cmd)}`);
  if (b.search) parts.push(`searching (${b.search})`);
  if (b.agent)  parts.push(`${b.agent} agent${s(b.agent)} working`);
  if (b.web)    parts.push(`fetching from the web (${b.web})`);
  if (b.other)  parts.push(`${b.other} tool call${s(b.other)}`);
  const joined = parts.join(", ") || "working";
  return joined[0]!.toUpperCase() + joined.slice(1);
}

/**
 * Parse a tier change out of x_klaatai.reason. Two server markers:
 *   `hint_clamped:heavy->code(plan:free)` — the tier you asked for isn't on your plan (D3)
 *   `plan_enforced:heavy->reason`         — you hit that tier's daily/monthly cap
 * Returns null when the served tier matched the request (nothing to explain).
 */
export function parseClamp(reason?: string): {
  from: string; to: string; why?: string; kind: "plan" | "cap";
} | null {
  if (!reason) return null;
  const clamp = reason.match(/hint_clamped:(\w+)->(\w+)(?:\(([^)]*)\))?/);
  if (clamp && clamp[1] !== clamp[2]) {
    return { from: clamp[1]!, to: clamp[2]!, why: clamp[3], kind: "plan" };
  }
  const cap = reason.match(/plan_enforced:(\w+)->(\w+)/);
  if (cap && cap[1] !== cap[2]) {
    return { from: cap[1]!, to: cap[2]!, kind: "cap" };
  }
  return null;
}

/** One-line explanation of a tier change — what was asked, what served, why, when it resets. */
export function describeClamp(c: { from: string; to: string; why?: string; kind: "plan" | "cap" }): string {
  const from = tierLabel(c.from) || c.from;
  const to = tierLabel(c.to) || c.to;
  if (c.kind === "cap") {
    return `${from} limit reached — served on ${to} instead. Limits reset ${monthlyResetLabel()} (daily ones at midnight UTC).`;
  }
  const why = c.why ? ` (${c.why})` : "";
  return `${from} isn't available on your plan${why} — served on ${to}.`;
}

// Rotating status verbs — one step every 3s of elapsed time.
export const THINKING_VERBS = [
  "Thinking", "Pondering", "Scheming", "Brewing", "Mulling", "Conjuring",
  "Deliberating", "Percolating", "Noodling", "Crunching", "Weaving", "Cooking",
];
export const WRITING_VERBS = ["Writing", "Composing", "Generating", "Drafting"];

// Placeholder tips — rotate while the input is empty so features get discovered.
export const PLACEHOLDER_TIPS = [
  'Ask anything… "Fix the TODO in main.ts"',
  'Try "@" to reference a file',
  'Try "!" to run a shell command',
  "Ctrl+V (or /paste) — attach a screenshot from the clipboard",
  "Ctrl+P — command palette · /help — all commands",
  '"/agents" — parallel sub-agents · "/model" — routing tier',
  '"/review" — AI code review of your git diff',
  "Ctrl+R — search input history",
];

// Syntax-highlight a shell command into colored spans for the permission card.
export function highlightCommand(cmd: string, maxW: number): Span[] {
  const parts = cmd.split(/(\s+)/);
  const spans: Span[] = [];
  let isFirst = true;
  let totalW = 0;

  for (const part of parts) {
    if (totalW >= maxW) break;
    if (/^\s+$/.test(part)) {
      spans.push(span(part, {}));
      totalW += part.length;
      continue;
    }
    let fg: number | string;
    if (isFirst) {
      fg = 114; // green — command name
      isFirst = false;
    } else if (part.startsWith("-")) {
      fg = 222; // yellow — flags
    } else if (part.startsWith("/") || part.startsWith("~") || part.startsWith("./") || part.includes("/")) {
      fg = 81; // cyan — paths
    } else if (part.startsWith("http://") || part.startsWith("https://")) {
      fg = 81; // cyan — URLs
    } else if (/^[0-9]+$/.test(part)) {
      fg = 176; // purple — numbers
    } else if (part.startsWith("$") || part.startsWith("\"") || part.startsWith("'")) {
      fg = 215; // orange — variables/strings
    } else {
      fg = 252; // default light
    }
    const display = totalW + part.length > maxW ? part.slice(0, maxW - totalW - 1) + "…" : part;
    spans.push(span(display, { fg }));
    totalW += display.length;
  }
  return spans;
}

// Syntax-highlight a file path: directory parts dim, filename bright.
export function highlightPath(filePath: string, maxW: number): Span[] {
  const truncated = filePath.length > maxW ? "…" + filePath.slice(filePath.length - maxW + 1) : filePath;
  const lastSlash = truncated.lastIndexOf("/");
  if (lastSlash < 0) return [span(truncated, { fg: "white", bold: true })];
  return [
    span(truncated.slice(0, lastSlash + 1), { fg: 245 }),
    span(truncated.slice(lastSlash + 1), { fg: "white", bold: true }),
  ];
}

// Right-side tips below input — short actionable hints, rotate every 8s.
export const META_TIPS = [
  "tip: @ to attach files",
  "tip: /compact to free context",
  "tip: Ctrl+B toggle sidebar",
  "tip: /tier heavy for complex tasks",
  "tip: /clear to reset session",
  "tip: /cost to see usage stats",
  "tip: /theme to change colors",
  "tip: /undo to revert last edit",
];
