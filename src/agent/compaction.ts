/**
 * Mechanical, retention-aware context compaction.
 *
 * Applied to the message list before every request. Ranks old tool results by
 * usefulness instead of truncating them all equally:
 *   - the LATEST read of each file is kept full (the model's current view of a
 *     file it may still be editing) — never truncated;
 *   - superseded reads of the same file are trimmed hard (stale);
 *   - search/exploration output (grep/glob/list/web) is trimmed hardest — it's
 *     noise once the model has acted on it;
 *   - everything else falls back to the default limit.
 * Then strips thinking blocks and, as a last resort, drops oldest turns to fit.
 */

import type { Message } from "../api/client.js";

const OLD_TOOL_RESULT_LIMIT = 400; // default chars kept for old tool results
const STALE_SEARCH_LIMIT = 180;    // grep/glob/list — noise once consumed
const STALE_READ_LIMIT = 160;      // superseded reads of a file
const RECENT_TURNS_FULL = 6;       // keep last N assistant turns with full tool results
const MAX_SEND_CHARS = 240_000;    // hard cap on chars sent (~60K tokens)

/** Output-token headroom reserved out of the tier window before budgeting input. */
const OUTPUT_RESERVE_TOKENS = 8_000;
const CHARS_PER_TOKEN = 4;

const SEARCH_TOOLS = new Set(["grep", "glob", "list_dir", "web_search", "web_fetch", "todo_read"]);
const MUTATING_TOOLS = new Set(["write_file", "edit_file", "multi_edit", "apply_patch"]);

/**
 * Char budget for a given tier context window (tokens). Smaller locked tiers
 * (nano 16K, fast 32K) get a proportionally smaller send budget so the request
 * fits without the server blind-chopping it; large windows keep the 240K
 * default — it already leaves room for router demotion mid-session.
 */
export function charBudgetForWindow(contextWindowTokens?: number): number {
  if (!contextWindowTokens || contextWindowTokens <= 0) return MAX_SEND_CHARS;
  const usable = Math.max(4_000, contextWindowTokens - OUTPUT_RESERVE_TOKENS);
  return Math.min(MAX_SEND_CHARS, Math.round(usable * CHARS_PER_TOKEN * 0.85));
}

/**
 * Attention-ordered arrangement of the old-history zone (roadmap 9.3).
 *
 * LLMs attend most strongly to the start and end of the context window and
 * weakest to the middle ("lost in the middle"). The old zone — everything
 * between the protected system seed and the protected recent turns — sits in
 * that weak middle by construction. Within it, we move the highest-relevance
 * turn groups to the zone's edges and bury low-relevance exploration noise in
 * its center.
 *
 * Correctness constraints:
 *   - only whole TURN GROUPS move (a user message plus the assistant/tool
 *     messages that follow it), so assistant tool_calls always stay adjacent
 *     to their tool results — providers reject orphaned pairings;
 *   - a compaction-summary stub is pinned to the front of the zone;
 *   - zones with fewer than MIN_GROUPS_TO_REORDER groups are left in
 *     chronological order (nothing meaningful to gain).
 */
const MIN_GROUPS_TO_REORDER = 6;

function groupScore(group: Message[]): number {
  let score = 0;
  for (const m of group) {
    const c = typeof m.content === "string" ? m.content : "";
    if (m.role === "assistant" && c.startsWith("[Context compacted")) score += 100; // pin front
    if (m.role === "user" && c.length > 200) score += 2;              // real instructions
    if (m.role === "tool") {
      if (/\bchars trimmed\b/.test(c)) score -= 1;                     // already-degraded noise
      else if (c.length > 800) score += 2;                             // surviving full read
      else if (/^OK[:,]|^Applied|^Edited|^Wrote/.test(c)) score += 1;  // mutation record
    }
  }
  return score;
}

/** Split a message span into turn groups (each starts at a user message). */
function splitTurnGroups(zone: Message[]): Message[][] {
  const groups: Message[][] = [];
  for (const m of zone) {
    if (m.role === "user" || groups.length === 0) groups.push([m]);
    else groups[groups.length - 1]!.push(m);
  }
  return groups;
}

/** Arrange ranked groups edges-first: best at the zone's start and end, worst in the middle. */
export function orderForAttention(zone: Message[]): Message[] {
  const groups = splitTurnGroups(zone);
  if (groups.length < MIN_GROUPS_TO_REORDER) return zone;
  const ranked = groups
    .map((g, idx) => ({ g, idx, score: groupScore(g) }))
    .sort((a, b) => b.score - a.score || a.idx - b.idx); // stable: ties stay chronological
  const front: Message[][] = [];
  const back: Message[][] = [];
  ranked.forEach((r, i) => (i % 2 === 0 ? front.push(r.g) : back.unshift(r.g)));
  return [...front, ...back].flat();
}

export function compactMessagesForApi(
  msgs: Message[],
  contextWindowTokens?: number,
  opts?: { attentionOrder?: boolean },
): Message[] {
  const maxSendChars = charBudgetForWindow(contextWindowTokens);
  // On tight budgets, trim old tool results proportionally harder too.
  const factor = Math.max(0.25, Math.min(1, maxSendChars / MAX_SEND_CHARS));
  const oldToolLimit = Math.round(OLD_TOOL_RESULT_LIMIT * factor);
  const staleSearchLimit = Math.round(STALE_SEARCH_LIMIT * factor);
  const staleReadLimit = Math.round(STALE_READ_LIMIT * factor);
  // Strip thinking blocks from assistant messages
  let result = msgs.map((m) => {
    if (m.role === "assistant" && typeof m.content === "string" &&
        /<(?:thinking|reasoning)>/.test(m.content)) {
      const cleaned = m.content.replace(/<(?:thinking|reasoning)>[\s\S]*?<\/(?:thinking|reasoning)>/g, "").trim();
      return { ...m, content: cleaned || m.content };
    }
    return m;
  });

  // Map tool_call_id → { name, path } from assistant tool_calls.
  const callMeta = new Map<string, { name: string; path?: string }>();
  for (const m of result) {
    if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) {
        let path: string | undefined;
        try { path = (JSON.parse(tc.function.arguments) as { path?: string; file_path?: string }).path
          ?? (JSON.parse(tc.function.arguments) as { file_path?: string }).file_path; } catch { /* */ }
        callMeta.set(tc.id, { name: tc.function.name, path });
      }
    }
  }

  // Index of the latest read_file result per path (protected from truncation).
  const latestReadIdx = new Map<string, number>();
  result.forEach((m, i) => {
    if (m.role !== "tool" || !m.tool_call_id) return;
    const meta = callMeta.get(m.tool_call_id);
    if (meta?.name === "read_file" && meta.path) latestReadIdx.set(meta.path, i);
  });

  // Find cutoff: protect the last N assistant turns entirely.
  let assistantCount = 0;
  let cutoffIdx = result.length;
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i].role === "assistant") {
      assistantCount++;
      if (assistantCount >= RECENT_TURNS_FULL) { cutoffIdx = i; break; }
    }
  }

  // Retention-aware truncation of old tool results.
  result = result.map((m, i) => {
    if (i >= cutoffIdx || m.role !== "tool" || typeof m.content !== "string") return m;
    const meta = m.tool_call_id ? callMeta.get(m.tool_call_id) : undefined;
    const name = meta?.name ?? "";

    // Protect the latest read of each file — the model may still be editing it.
    if (name === "read_file" && meta?.path && latestReadIdx.get(meta.path) === i) return m;
    if (MUTATING_TOOLS.has(name)) return m; // "OK: edited …" is already tiny

    const limit =
      SEARCH_TOOLS.has(name)   ? staleSearchLimit :
      name === "read_file"     ? staleReadLimit :     // superseded read
      oldToolLimit;

    if (m.content.length <= limit) return m;
    return {
      ...m,
      content: m.content.slice(0, limit) +
        `\n[… ${m.content.length - limit} chars trimmed — ${name || "older context"}]`,
    };
  });

  // Hard cap: if total chars still exceed budget, drop oldest turns
  const totalChars = () => result.reduce((sum, m) =>
    sum + (typeof m.content === "string" ? m.content.length : 0), 0);

  if (totalChars() > maxSendChars) {
    // Protect the entire leading system block (core prompt, environment,
    // project rules, mode prompt) — not just the first message.
    let sysEnd = 0;
    while (sysEnd < result.length && result[sysEnd].role === "system") sysEnd++;
    const system = result.slice(0, sysEnd);
    let body = result.slice(system.length);
    while (totalChars() > maxSendChars && body.length > RECENT_TURNS_FULL) {
      let end = 1;
      while (end < body.length && body[end].role !== "user") end++;
      if (end >= body.length) break;
      body = body.slice(end);
      result = [...system, ...body];
    }
  }

  // 9.3: attention-order the old zone LAST — after the hard cap, so the
  // drop-oldest loop above still removes chronologically-oldest turns, not
  // the high-relevance groups this pass moves to the front.
  if (opts?.attentionOrder !== false) {
    let sysEnd = 0;
    while (sysEnd < result.length && result[sysEnd].role === "system") sysEnd++;
    // Recompute the protected-recent boundary on the post-cap array…
    let assistants = 0;
    let cut = result.length;
    for (let i = result.length - 1; i >= sysEnd; i--) {
      if (result[i].role === "assistant") {
        assistants++;
        if (assistants >= RECENT_TURNS_FULL) { cut = i; break; }
      }
    }
    // …then pull it back to a turn-group boundary so no user message is
    // separated from its assistant reply.
    while (cut > sysEnd && cut < result.length && result[cut].role !== "user") cut--;
    if (cut > sysEnd) {
      result = [
        ...result.slice(0, sysEnd),
        ...orderForAttention(result.slice(sysEnd, cut)),
        ...result.slice(cut),
      ];
    }
  }

  return result;
}
