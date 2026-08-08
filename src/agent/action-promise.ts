/**
 * Detects a round that PROMISES an action without taking one.
 *
 * Weak models (fast tier, vision fallbacks) routinely end a turn with "I'll
 * now fix it and re-deploy. One moment —" and zero tool calls. The agent loop
 * treats a no-tool-call round as the final answer, so the turn ends and
 * nothing happens no matter how often the user re-asks (seen live
 * 2026-08-02). The REPL uses this to grant such a round a bounded nudge —
 * "call the tool NOW" — instead of ending the turn.
 *
 * Deliberately narrow: first-person future/progressive + a concrete work
 * verb, or the stock stall phrases. A closing question ("want me to…?") is a
 * legitimate handoff to the user and never counts.
 */

const VERB =
  "(?:fix|creat|rewrit|writ|updat|edit|run|rerun|start|restart|deploy|redeploy|" +
  "implement|add|remov|build|rebuild|install|delet|mak|do|apply|generat|refactor|clean|" +
  // Exploration verbs — "Let me read the rest of the file." then a dead stop is
  // the same unfulfilled promise as "I'll fix it" (seen live 2026-08-08, code
  // tier). "know" is deliberately absent so "let me know" stays a handoff.
  "read|re-read|reread|check|look|inspect|examin|verify|review|search|find|grep|scan|explor|open)";

export const ACTION_PROMISE_RE = new RegExp(
  "\\b(?:" +
    // "I'll fix", "I will now rewrite", "I'm going to delete", "I am rewriting"
    `i(?:['’]ll|['’]m|\\s+will|\\s+am)\\s+(?:not\\s+stop\\b|(?:now\\s+|going\\s+to\\s+|about\\s+to\\s+)?${VERB}\\w*)` +
    // "let me fix", "let me now rewrite"
    `|let\\s+me\\s+(?:now\\s+)?${VERB}\\w*` +
    "|one\\s+moment" +
    "|starting\\s+fresh\\s+now" +
  ")\\b",
  "i",
);

/** True when `text` reads as an unfulfilled promise to act (no trailing
 * question — a question hands the turn to the user legitimately). */
export function looksLikeUnfulfilledActionPromise(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t || /\?\s*$/.test(t)) return false;
  return ACTION_PROMISE_RE.test(t);
}
