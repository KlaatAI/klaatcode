/**
 * Strips leftover text-protocol pseudo-tool-call syntax from assistant
 * output before it's displayed or stored in conversation history.
 *
 * A model occasionally falls back to `<function=name>...</function>` instead
 * of a real tool_calls response — weak instruction-following, or (for a
 * custom third-party model added via /model add) because no server-side
 * text-tool-call parsing exists at all, since Klaatu isn't in that request
 * path. Klaatu scrubs this for its own responses (server-side
 * core/parse_text_tools.py); this is the only defense for custom endpoints,
 * and a last-resort safety net if a malformed/truncated block ever slips
 * through regardless. Display-only — never attempts to parse or execute
 * these, just keeps the raw XML off screen and out of history.
 */

const FULL_BLOCK_RE =
  /<function(?:=[a-zA-Z0-9_]+|\s+name=["'][a-zA-Z0-9_]+["'])\s*>[\s\S]*?<\/function>/gi;
const STRAY_TAG_RE = /<\/?(?:function|parameter|tool_call)(?:[^>]*)?>/gi;

// Klaatu's web-chat pipeline instructs models to wrap generated apps in
// <klaatu_creation lang="…" title="…"> markers for the web canvas. That
// prompt must never reach an editor client, but a server misclassification
// (seen live 2026-07-19: toolless request → web pipeline) leaks it into the
// terminal. Strip the wrapper tags, keep the inner content.
const CREATION_TAG_RE = /<\/?klaatu_creation(?:\s[^>]*)?>/gi;

export function stripStrayTextToolCallArtifacts(text: string): string {
  return text
    .replace(FULL_BLOCK_RE, "")
    .replace(STRAY_TAG_RE, "")
    .replace(CREATION_TAG_RE, "");
}

// Live-stream variant: the final-message strip above only runs when the turn
// ends, so a text-protocol tool call streams onto the screen token by token
// (seen live 2026-08-02 on the fast/vision tier: a raw <tool_call> block was
// the whole visible "answer"). While streaming, an OPENER may be present with
// its closer still in flight — hold back everything from the opener on, and
// also swallow a trailing partial tag ("<tool_c") so it never flashes.
const STREAM_OPENER_RE = /<(?:tool_call|function(?:=|\s|>)|\/tool_call)/i;
const PARTIAL_TAIL_RE = /<\/?([a-zA-Z_]{0,9})$/;
const HOLDABLE_TAGS = ["tool_call", "function", "parameter"];
// A COMPLETE wrapper pair (same shape as the server's _TOOL_CALL_BLOCK) —
// removed before the opener check so only genuinely in-flight blocks hold.
const TOOL_CALL_PAIR_RE = /<tool_call>[\s\S]*?<\/tool_call>/gi;

export function maskTextToolXmlForDisplay(text: string): string {
  let out = text
    .replace(TOOL_CALL_PAIR_RE, "")
    .replace(FULL_BLOCK_RE, "")
    .replace(CREATION_TAG_RE, "");
  const opener = STREAM_OPENER_RE.exec(out);
  if (opener) {
    out = out.slice(0, opener.index);
  } else {
    const tail = PARTIAL_TAIL_RE.exec(out);
    if (tail && HOLDABLE_TAGS.some(t => t.startsWith(tail[1]!.toLowerCase()))) {
      out = out.slice(0, tail.index);
    }
  }
  return out.replace(STRAY_TAG_RE, "");
}
