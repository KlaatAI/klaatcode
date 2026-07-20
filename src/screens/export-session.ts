/**
 * Render a KlaatAI session transcript to clean Markdown for /export.
 *
 * Pure function — unit-tested — so the REPL can stay thin.
 */

export interface ExportDiffLine {
  sign: "+" | "-" | " ";
  text: string;
  ln?: number;
}

export interface ExportMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolName?: string;
  toolSummary?: string;
  kind?: "error";
  diff?: ExportDiffLine[];
  diffPath?: string;
  elapsed?: number;
  model?: string;
  tier?: string;
}

export interface ExportOptions {
  sessionId: string;
  messages: ExportMessage[];
  sessionCost: number;
  totalRequests: number;
  /** Defaults to now. Injected for tests. */
  exportedAt?: Date;
}

function summarizeTool(msg: ExportMessage): string {
  if (msg.toolSummary && msg.toolSummary !== msg.toolName) return msg.toolSummary;
  return msg.toolName ?? "unknown";
}

function diffStat(diff: ExportDiffLine[]): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const d of diff) {
    if (d.sign === "+") add++;
    else if (d.sign === "-") del++;
  }
  return { add, del };
}

/** Fence long enough that nested backticks in `body` cannot close the block early. */
export function fenceFor(body: string, info = ""): { open: string; close: string } {
  let longest = 2; // at least ```
  const re = /`+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if (m[0].length > longest) longest = m[0].length;
  }
  const ticks = "`".repeat(longest + 1);
  return { open: info ? `${ticks}${info}` : ticks, close: ticks };
}

function renderDiffBlock(msg: ExportMessage): string {
  const lines: string[] = [];
  const pathNote = msg.diffPath ? ` ${msg.diffPath}` : "";
  const st = msg.diff ? diffStat(msg.diff) : { add: 0, del: 0 };
  const stats =
    st.add || st.del
      ? ` (+${st.add} −${st.del})`
      : "";
  lines.push(`### Tool: ${summarizeTool(msg)}${pathNote}${stats}`);
  lines.push("");
  if (msg.diff && msg.diff.length > 0) {
    const body = msg.diff.map(d => `${d.sign}${d.text}`).join("\n");
    const { open, close } = fenceFor(body, "diff");
    lines.push(open);
    lines.push(body);
    lines.push(close);
    lines.push("");
  }
  return lines.join("\n");
}

function renderToolBlock(msg: ExportMessage): string {
  if (msg.diff && msg.diff.length > 0) return renderDiffBlock(msg);

  const label = summarizeTool(msg);
  const body = msg.content.trimEnd();
  const lineCount = body ? body.split("\n").length : 0;
  const oneLine =
    lineCount <= 1 && body.length <= 120
      ? body.replace(/\n/g, " ").trim()
      : "";

  const lines: string[] = [];
  lines.push(`### Tool: ${label}`);
  lines.push("");

  if (!body) {
    lines.push("_(no output)_");
    lines.push("");
    return lines.join("\n");
  }

  if (oneLine) {
    const { open, close } = fenceFor(oneLine);
    lines.push(open);
    lines.push(oneLine);
    lines.push(close);
    lines.push("");
    return lines.join("\n");
  }

  // Collapsed details for longer tool output — readable without dumping JSON.
  const { open, close } = fenceFor(body);
  lines.push(`<details>`);
  lines.push(`<summary>${label} · ${lineCount} lines</summary>`);
  lines.push("");
  lines.push(open);
  lines.push(body);
  lines.push(close);
  lines.push("");
  lines.push("</details>");
  lines.push("");
  return lines.join("\n");
}

/**
 * Default export path: `./klaatai-session-<id>.md` (cwd-relative).
 * An explicit path argument overrides this entirely.
 */
export function defaultExportPath(sessionId: string, cwd = process.cwd()): string {
  return `${cwd.replace(/\/$/, "")}/klaatai-session-${sessionId}.md`;
}

/** Resolve `/export [path]` — empty/undefined → default under cwd. */
export function resolveExportPath(sessionId: string, pathArg?: string, cwd = process.cwd()): string {
  const trimmed = pathArg?.trim();
  if (!trimmed) return defaultExportPath(sessionId, cwd);
  // Expand a lone bare filename into cwd; leave absolute / relative paths as-is.
  return trimmed;
}

export function renderSessionMarkdown(opts: ExportOptions): string {
  const when = (opts.exportedAt ?? new Date()).toISOString().slice(0, 19);
  const out: string[] = [
    `# KlaatAI Session — ${opts.sessionId}`,
    `*Exported: ${when}*`,
    "",
  ];

  for (const m of opts.messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      out.push(`## You`);
      out.push("");
      out.push(m.content);
      out.push("");
      continue;
    }
    if (m.role === "assistant") {
      if (m.kind === "error") {
        out.push(`## Error`);
        out.push("");
        out.push(m.content);
        out.push("");
        continue;
      }
      const meta: string[] = [];
      if (m.tier) meta.push(`tier: ${m.tier}`);
      if (m.model) meta.push(`model: ${m.model}`);
      if (m.elapsed != null) meta.push(`${(m.elapsed / 1000).toFixed(1)}s`);
      out.push(`## Assistant${meta.length ? ` _( ${meta.join(" · ")} )_` : ""}`);
      out.push("");
      out.push(m.content);
      out.push("");
      continue;
    }
    if (m.role === "tool") {
      out.push(renderToolBlock(m));
    }
  }

  out.push("---");
  out.push(
    `*Session cost: $${opts.sessionCost.toFixed(4)} | Requests: ${opts.totalRequests}*`,
  );
  out.push("");
  return out.join("\n");
}
