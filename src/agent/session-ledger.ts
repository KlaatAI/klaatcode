/**
 * Session ledger — durable, out-of-context session memory.
 *
 * A plain-markdown file recording what happened this session: files touched,
 * commands run, decisions made, compaction summaries. It is NOT injected into
 * every request (that would duplicate history and waste input tokens). Instead:
 *
 *   - the system prompt carries one stable line pointing at the ledger path;
 *     any routed model can read_file it on demand when context has been
 *     compacted past the details it needs;
 *   - compaction appends its summary here, so compacted details stay
 *     recoverable instead of vanishing;
 *   - entries from tool calls are written mechanically — zero LLM cost.
 *
 * With per-request model routing, this is the shared notebook every model in
 * the session can consult, regardless of which turns it personally served.
 */

import { appendFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class SessionLedger {
  readonly path: string;
  private enabled = true;

  constructor(path: string) {
    this.path = path;
    try {
      mkdirSync(dirname(path), { recursive: true });
      if (!existsSync(path)) {
        writeFileSync(
          path,
          `# Session ledger\n\nAppend-only log of key events this session. ` +
          `Read specific sections with read_file offset/limit when conversation context lacks details.\n\n`,
          "utf-8",
        );
      }
    } catch {
      this.enabled = false;
    }
  }

  private append(line: string): void {
    if (!this.enabled) return;
    try {
      const ts = new Date().toISOString().slice(11, 19);
      appendFileSync(this.path, `- ${ts} ${line}\n`, "utf-8");
    } catch { /* ledger is best-effort — never break the session over it */ }
  }

  fileWritten(relPath: string, kind: "write" | "edit" | "multi_edit"): void {
    this.append(`${kind === "write" ? "wrote" : "edited"} \`${relPath}\``);
  }

  commandRun(command: string, exitCode: number): void {
    const cmd = command.length > 120 ? command.slice(0, 117) + "…" : command;
    this.append(`ran \`${cmd}\` (exit ${exitCode})`);
  }

  userAsked(text: string): void {
    const t = text.replace(/\s+/g, " ").trim();
    this.append(`user: ${t.length > 200 ? t.slice(0, 197) + "…" : t}`);
  }

  note(text: string): void {
    this.append(text);
  }

  /** Pre-compaction snapshot of critical state (9.6) — the recovery source a
   * later model reads when a compaction check reports possible context loss. */
  sessionState(state: { taskIntent: string | null; files: string[] }): void {
    if (!this.enabled) return;
    try {
      const lines = [
        `\n## Session state (pre-compaction ${new Date().toISOString().slice(0, 16)})`,
        "",
        `Task intent: ${state.taskIntent ?? "(none captured)"}`,
        state.files.length ? `Files modified: ${state.files.join(", ")}` : "Files modified: (none)",
        "",
      ];
      appendFileSync(this.path, lines.join("\n"), "utf-8");
    } catch { /* best-effort */ }
  }

  compacted(summary: string): void {
    if (!this.enabled) return;
    try {
      appendFileSync(
        this.path,
        `\n## Compaction summary (${new Date().toISOString().slice(0, 16)})\n\n${summary.trim()}\n\n`,
        "utf-8",
      );
    } catch { /* best-effort */ }
  }
}
