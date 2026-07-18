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
