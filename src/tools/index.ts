/**
 * Tool implementations for the KlaatAI CLI agentic loop.
 *
 * Architecture:
 *   - TOOL_DEFINITIONS  — OpenAI-compatible schemas sent to the model
 *   - executeTools()    — dispatches ToolCall → string result
 *   - Each tool is a pure function: (args, projectRoot) → string
 *
 * All paths are resolved relative to projectRoot unless absolute.
 * All output is capped at MAX_OUTPUT chars to avoid flooding the context.
 */

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { homedir } from "node:os";
import { execSync, spawnSync } from "node:child_process";
import { type ToolCall, type ToolDefinition, type KlaatAIClient } from "../api/client.js";
import { replaceInContent, type ReplaceResult } from "./edit-engine.js";
import { recordFileRead, checkMutationAllowed } from "./file-state.js";
import { runDiagnostics } from "./diagnostics.js";
import { parsePatch } from "./apply-patch.js";
import { extractSymbols } from "./regex-symbols.js";
import { startBackground, readBackground, killBackground } from "./background.js";
import { filterCommandOutput } from "./output-filter.js";
import { buildPlan, renderPlan, type GraphAccess } from "./exploration-planner.js";
import { resolveProjectId } from "../utils/project-id.js";
import {
  localDbQuery, localDbFileSymbols, localDbCallers, localDbSemanticSearch,
  type LocalSymbol,
} from "./local-db.js";
import { embedQuery } from "./code-embedder.js";
import { browserSession } from "./browser-session.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_OUTPUT = 12_000; // characters returned to model
const DEFAULT_READ_LINES = 200;
const MAX_GLOB_RESULTS = 200;
const MAX_GREP_LINES = 150;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function truncate(s: string, max = MAX_OUTPUT): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n[... ${s.length - max} chars truncated ...]`;
}

// ─── Oversized-result persistence ────────────────────────────────────────────
// Instead of throwing away everything past MAX_OUTPUT (forcing re-runs), save
// the full output to disk and hand the model a short preview + the path. The
// model can read_file slices of it on demand — far cheaper than resending or
// regenerating the output.

const RESULTS_DIR = join(homedir(), ".klaatai", "tool-results");
const PREVIEW_CHARS = 2_000;
let resultCounter = 0;

function persistOversized(s: string, label: string): string {
  if (s.length <= MAX_OUTPUT) return s;
  try {
    mkdirSync(RESULTS_DIR, { recursive: true });
    const file = join(RESULTS_DIR, `${process.pid}-${++resultCounter}-${label}.txt`);
    writeFileSync(file, s, "utf-8");
    let preview = s.slice(0, PREVIEW_CHARS);
    const nl = preview.lastIndexOf("\n");
    if (nl > PREVIEW_CHARS / 2) preview = preview.slice(0, nl);
    return (
      `Output too large (${s.length} chars). Full output saved to: ${file}\n` +
      `Use read_file with offset/limit on that path to inspect more.\n\n` +
      `Preview (first ~2KB):\n${preview}`
    );
  } catch {
    return truncate(s);
  }
}

/**
 * Resolve a path relative to projectRoot, or return as-is if absolute.
 */
export function safeResolve(projectRoot: string, filePath: string): string {
  if (filePath.startsWith("/") || filePath.startsWith("~")) {
    return filePath.replace(/^~/, process.env["HOME"] ?? "~");
  }
  return resolve(projectRoot, filePath);
}

// ─── Write sandbox ────────────────────────────────────────────────────────────
// Writes/edits default to the project directory. Paths outside it are refused
// unless the user allowlisted them; a few critical system paths are ALWAYS
// refused regardless of settings. Reads are never sandboxed.

interface SandboxConfig { enabled: boolean; root: string; allow: string[] }
let sandbox: SandboxConfig = { enabled: true, root: process.cwd(), allow: [] };

/** Paths that must never be written by the agent, even with the sandbox off. */
const HARD_DENY = [
  "/etc", "/bin", "/sbin", "/usr", "/System", "/Library", "/boot", "/dev", "/proc",
  join(homedir(), ".ssh"),
  join(homedir(), ".aws"),
  join(homedir(), ".config", "gcloud"),
];

export function configureSandbox(opts: Partial<SandboxConfig>): void {
  sandbox = { ...sandbox, ...opts };
  sandbox.allow = (opts.allow ?? sandbox.allow).map(p =>
    resolve(p.replace(/^~/, homedir())));
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !resolve(child).includes("../"));
}

/**
 * Returns an error string if writing absPath is not allowed, else null.
 */
function checkWriteAllowed(absPath: string): string | null {
  const p = resolve(absPath);
  for (const deny of HARD_DENY) {
    if (isInside(p, deny)) {
      return `Error: Refusing to write to a protected system path (${deny}). This is never permitted.`;
    }
  }
  if (!sandbox.enabled) return null;
  if (isInside(p, sandbox.root)) return null;
  for (const a of sandbox.allow) {
    if (isInside(p, a)) return null;
  }
  return (
    `Error: "${p}" is outside the project directory (${sandbox.root}). ` +
    `Writes are sandboxed to the project. To allow this location, add it to ` +
    `"sandboxAllow" in ~/.klaatai/config.json, or disable with "sandbox": "off".`
  );
}

// ─── Tool: read_file ─────────────────────────────────────────────────────────

interface ReadFileArgs {
  path: string;
  offset?: number; // 1-indexed start line
  limit?: number;  // max lines
}

function readFile(args: ReadFileArgs, projectRoot: string): string {
  const absPath = safeResolve(projectRoot, args.path);
  if (!existsSync(absPath)) return `Error: File not found: ${args.path}`;

  let stat: ReturnType<typeof statSync>;
  try { stat = statSync(absPath); } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }

  if (stat.isDirectory()) {
    // Delegate to list_dir behaviour if user passes a dir by mistake
    return listDir({ path: args.path }, projectRoot);
  }

  try {
    const content = readFileSync(absPath, "utf-8");
    recordFileRead(absPath);
    const lines = content.split("\n");
    const offset = Math.max(1, args.offset ?? 1);
    const limit = args.limit ?? DEFAULT_READ_LINES;
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const numbered = slice.map((l, i) => `${offset + i}: ${l}`).join("\n");
    const remaining = lines.length - (offset - 1 + limit);
    const note = remaining > 0 ? `\n[... ${remaining} more lines — use offset/limit to read further]` : "";
    return truncate(numbered + note);
  } catch (e) {
    return `Error reading file: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ─── Tool: write_file ────────────────────────────────────────────────────────

interface WriteFileArgs {
  path: string;
  content: string;
}

function writeFile(args: WriteFileArgs, projectRoot: string): string {
  const absPath = safeResolve(projectRoot, args.path);
  const sb = checkWriteAllowed(absPath);
  if (sb) return sb;
  if (existsSync(absPath)) {
    const freshness = checkMutationAllowed(absPath, true);
    if (freshness) return freshness;
  }
  try {
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, args.content, "utf-8");
    recordFileRead(absPath);
    const lineCount = args.content.split("\n").length;
    return `OK: Wrote ${lineCount} lines to ${relative(projectRoot, absPath)}` +
      (runDiagnostics(absPath, projectRoot) ?? "");
  } catch (e) {
    return `Error writing file: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ─── Auto-impact: blast-radius note after editing an exported symbol ──────────
// After an edit to a code file, if the changed text touches an EXPORTED symbol
// that has callers in the graph, append a compact impact note so the model
// re-verifies affected sites in the same turn. Uses the local graph only —
// cheap, no network, silent when the graph is empty.

function impactNoteForEdit(absPath: string, projectRoot: string, changedText: string): string {
  try {
    const proj = resolveProjectId(projectRoot);
    if (!proj) return "";
    const ext = absPath.split(".").pop()?.toLowerCase() ?? "";
    const language = ext;
    const source = readFileSync(absPath, "utf-8");
    const symbols = extractSymbols(language, ext, source);
    if (symbols.length === 0) return "";
    // Which symbols' names appear in the changed text (rough overlap)?
    const touched = symbols.filter(s => s.is_exported && changedText.includes(s.name)).slice(0, 4);
    const notes: string[] = [];
    for (const s of touched) {
      const callers = localDbCallers(proj.id, s.name, 2);
      if (callers.length === 0) continue;
      const sites = callers.slice(0, 5).map(c => `${c.callerName} (${c.callerFile})`).join(", ");
      const more = callers.length > 5 ? ` +${callers.length - 5} more` : "";
      notes.push(`  ${s.name}: ${callers.length} caller${callers.length === 1 ? "" : "s"} — ${sites}${more}`);
    }
    if (notes.length === 0) return "";
    return `\n\n⚠ Impact — changed exported symbol(s) have callers; verify these still work:\n${notes.join("\n")}`;
  } catch {
    return "";
  }
}

// ─── Tool: edit_file ─────────────────────────────────────────────────────────

interface EditFileArgs {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

function describeEditFailure(result: Extract<ReplaceResult, { ok: false }>, path: string): string {
  switch (result.reason) {
    case "identical": return `Error: old_string and new_string are identical in ${path} — nothing to change.`;
    case "multiple":  return `Error: ${result.hint}`;
    case "not_found": return `Error: old_string not found in ${path}. ${result.hint ?? ""}`;
  }
}

function editFile(args: EditFileArgs, projectRoot: string): string {
  const absPath = safeResolve(projectRoot, args.path);
  if (!existsSync(absPath)) return `Error: File not found: ${args.path}`;
  const sb = checkWriteAllowed(absPath);
  if (sb) return sb;
  const freshness = checkMutationAllowed(absPath, true);
  if (freshness) return freshness;

  try {
    const content = readFileSync(absPath, "utf-8");
    const result  = replaceInContent(content, args.old_string, args.new_string, args.replace_all ?? false);
    if (!result.ok) return describeEditFailure(result, args.path);

    writeFileSync(absPath, result.content, "utf-8");
    recordFileRead(absPath);
    const via = result.matchedBy === "exact" ? "" : ` (matched via ${result.matchedBy})`;
    return `OK: Replaced ${result.occurrences} occurrence${result.occurrences === 1 ? "" : "s"} in ${relative(projectRoot, absPath)}${via}` +
      (runDiagnostics(absPath, projectRoot) ?? "") +
      impactNoteForEdit(absPath, projectRoot, args.new_string);
  } catch (e) {
    return `Error editing file: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ─── Tool: multi_edit ────────────────────────────────────────────────────────

interface MultiEditArgs {
  path: string;
  edits: { old_string: string; new_string: string; replace_all?: boolean }[];
}

/** Apply several edits to one file atomically — all succeed or none are written. */
function multiEdit(args: MultiEditArgs, projectRoot: string): string {
  const absPath = safeResolve(projectRoot, args.path);
  if (!existsSync(absPath)) return `Error: File not found: ${args.path}`;
  if (!Array.isArray(args.edits) || args.edits.length === 0) {
    return "Error: multi_edit requires a non-empty 'edits' array.";
  }
  const sb = checkWriteAllowed(absPath);
  if (sb) return sb;
  const freshness = checkMutationAllowed(absPath, true);
  if (freshness) return freshness;

  try {
    let content = readFileSync(absPath, "utf-8");
    let total = 0;
    for (let i = 0; i < args.edits.length; i++) {
      const e = args.edits[i]!;
      const result = replaceInContent(content, e.old_string, e.new_string, e.replace_all ?? false);
      if (!result.ok) {
        return `Error: edit ${i + 1}/${args.edits.length} failed — ${describeEditFailure(result, args.path).replace(/^Error: /, "")} No changes were written.`;
      }
      content = result.content;
      total += result.occurrences;
    }
    writeFileSync(absPath, content, "utf-8");
    recordFileRead(absPath);
    return `OK: Applied ${args.edits.length} edits (${total} replacement${total === 1 ? "" : "s"}) in ${relative(projectRoot, absPath)}` +
      (runDiagnostics(absPath, projectRoot) ?? "") +
      impactNoteForEdit(absPath, projectRoot, args.edits.map(e => e.new_string).join("\n"));
  } catch (e) {
    return `Error editing file: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ─── Tool: apply_patch ────────────────────────────────────────────────────────

interface ApplyPatchArgs { patch: string }

/** Multi-file envelope-diff patch, applied atomically (all-or-nothing). */
function applyPatch(args: ApplyPatchArgs, projectRoot: string): string {
  const parsed = parsePatch(args.patch ?? "");
  if (!parsed.ok) return `Error: ${parsed.error}`;

  // ── Phase 1: validate every op, compute new content — NO writes yet ──
  interface Plan { abs: string; rel: string; action: "write" | "delete"; content?: string; from?: string }
  const plan: Plan[] = [];
  for (const op of parsed.ops) {
    const abs = safeResolve(projectRoot, op.path);
    const rel = relative(projectRoot, abs);
    if (op.type === "add") {
      const sb = checkWriteAllowed(abs); if (sb) return sb;
      if (existsSync(abs)) return `Error: Add File ${op.path} — file already exists.`;
      plan.push({ abs, rel, action: "write", content: op.content });
    } else if (op.type === "delete") {
      const sb = checkWriteAllowed(abs); if (sb) return sb;
      if (!existsSync(abs)) return `Error: Delete File ${op.path} — not found.`;
      plan.push({ abs, rel, action: "delete" });
    } else {
      const sb = checkWriteAllowed(abs); if (sb) return sb;
      if (!existsSync(abs)) return `Error: Update File ${op.path} — not found.`;
      const fresh = checkMutationAllowed(abs, true); if (fresh) return fresh;
      let content = readFileSync(abs, "utf-8");
      for (let h = 0; h < op.hunks.length; h++) {
        const res = replaceInContent(content, op.hunks[h]!.oldStr, op.hunks[h]!.newStr, false);
        if (!res.ok) return `Error: Update File ${op.path}, hunk ${h + 1}/${op.hunks.length} did not apply (${res.reason}). ${res.hint ?? ""}`.trim();
        content = res.content;
      }
      if (op.moveTo) {
        const mAbs = safeResolve(projectRoot, op.moveTo);
        const mSb = checkWriteAllowed(mAbs); if (mSb) return mSb;
        plan.push({ abs: mAbs, rel: relative(projectRoot, mAbs), action: "write", content, from: abs });
        plan.push({ abs, rel, action: "delete" });
      } else {
        plan.push({ abs, rel, action: "write", content });
      }
    }
  }

  // ── Phase 2: commit (validation passed) ──
  const touched: string[] = [];
  try {
    for (const p of plan) {
      if (p.action === "delete") { if (existsSync(p.abs)) unlinkSync(p.abs); }
      else {
        mkdirSync(dirname(p.abs), { recursive: true });
        writeFileSync(p.abs, p.content ?? "", "utf-8");
        recordFileRead(p.abs);
        touched.push(p.abs);
      }
    }
  } catch (e) {
    return `Error applying patch (partial write may have occurred): ${e instanceof Error ? e.message : String(e)}`;
  }

  const summary = `OK: Applied patch — ${parsed.ops.length} file operation${parsed.ops.length === 1 ? "" : "s"}.`;
  const diags = touched.map(f => runDiagnostics(f, projectRoot)).filter(Boolean).join("");
  return summary + diags;
}

// ─── Tool: glob ──────────────────────────────────────────────────────────────

interface GlobArgs {
  pattern: string;
  path?: string;
}

// Bun.Glob is available at runtime — declare type locally to avoid requiring bun-types
type BunGlobType = {
  new (pattern: string): { scanSync(opts: { cwd: string; onlyFiles: boolean }): Iterable<string> };
};

function globFiles(args: GlobArgs, projectRoot: string): string {
  const searchDir = args.path ? safeResolve(projectRoot, args.path) : projectRoot;
  if (!existsSync(searchDir)) return `Error: Directory not found: ${args.path ?? "."}`;

  try {
    // Use Bun.Glob if available (primary runtime)
    const BunGlob = (globalThis as Record<string, unknown>)["Bun"] as
      { Glob: BunGlobType } | undefined;

    if (BunGlob?.Glob) {
      const g = new BunGlob.Glob(args.pattern);
      const matches = Array.from(g.scanSync({ cwd: searchDir, onlyFiles: false })).sort();
      if (matches.length === 0) return "No files matched.";
      const shown = matches.slice(0, MAX_GLOB_RESULTS);
      const note = matches.length > MAX_GLOB_RESULTS
        ? `\n[... ${matches.length - MAX_GLOB_RESULTS} more results]`
        : "";
      return shown.join("\n") + note;
    }

    // Fallback: use find (POSIX)
    const findPattern = args.pattern.replace(/\*\*/g, "*");
    const cmd = `find "${searchDir}" -name "${findPattern}" 2>/dev/null | head -${MAX_GLOB_RESULTS}`;
    const result = execSync(cmd, { encoding: "utf-8", timeout: 10_000 }).trim();
    if (!result) return "No files matched.";
    return result
      .split("\n")
      .map(p => relative(searchDir, p))
      .join("\n");
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ─── Tool: grep ──────────────────────────────────────────────────────────────

interface GrepArgs {
  pattern: string;
  path?: string;
  include?: string; // e.g. "*.ts"
}

function grepFiles(args: GrepArgs, projectRoot: string): string {
  const searchDir = args.path ? safeResolve(projectRoot, args.path) : projectRoot;
  if (!existsSync(searchDir)) return `Error: Directory not found: ${args.path ?? "."}`;

  try {
    const parts: string[] = [
      "grep", "-r", "-n", "--color=never",
      `--include=${args.include ?? "*"}`,
      "--",
      args.pattern,
      searchDir,
    ];

    const result = spawnSync(parts[0]!, parts.slice(1), {
      encoding: "utf-8",
      timeout: 15_000,
    });

    const output = (result.stdout ?? "").trim();
    if (!output) return "No matches found.";

    // Trim to MAX_GREP_LINES and relativize paths
    const lines = output.split("\n").slice(0, MAX_GREP_LINES);
    const rel = lines.map(l => {
      // grep output: /abs/path:line:content → rel/path:line:content
      const m = l.match(/^(\/[^:]+):(.+)$/);
      if (m) return `${relative(projectRoot, m[1]!)}:${m[2]}`;
      return l;
    });

    const remaining = output.split("\n").length - MAX_GREP_LINES;
    const note = remaining > 0 ? `\n[... ${remaining} more matches]` : "";
    return truncate(rel.join("\n") + note);
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ─── Tool: list_dir ──────────────────────────────────────────────────────────

interface ListDirArgs {
  path: string;
}

function listDir(args: ListDirArgs, projectRoot: string): string {
  const absPath = safeResolve(projectRoot, args.path);
  if (!existsSync(absPath)) return `Error: Path not found: ${args.path}`;

  try {
    const entries = readdirSync(absPath, { withFileTypes: true });
    if (entries.length === 0) return "(empty directory)";

    // Dirs first, then files, both sorted
    const dirs = entries.filter(e => e.isDirectory()).map(e => `${e.name}/`).sort();
    const files = entries.filter(e => !e.isDirectory()).map(e => e.name).sort();
    return truncate([...dirs, ...files].join("\n"));
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ─── Tool: run_command ───────────────────────────────────────────────────────

interface RunCommandArgs {
  command: string;
  workdir?: string;
  timeout?: number; // seconds
  background?: boolean;
}

function runCommand(args: RunCommandArgs, projectRoot: string): string {
  const cwd = args.workdir ? safeResolve(projectRoot, args.workdir) : projectRoot;
  const timeoutMs = (args.timeout ?? 30) * 1_000;

  if (!existsSync(cwd)) return `Error: Working directory not found: ${args.workdir}`;

  // Background: spawn detached, return an id the model polls with shell_output.
  if (args.background) {
    const id = startBackground(args.command, cwd);
    return `Started background shell ${id}: ${args.command}\nUse shell_output("${id}") to read output, shell_kill("${id}") to stop.`;
  }

  try {
    const result = spawnSync("sh", ["-c", args.command], {
      cwd,
      encoding: "utf-8",
      timeout: timeoutMs,
    });

    const stdout = (result.stdout ?? "").trim();
    const stderr = (result.stderr ?? "").trim();
    const exitCode = result.status ?? 0;

    let out = "";
    if (stdout) out += stdout;
    if (stderr) out += (out ? "\n[stderr]\n" : "[stderr]\n") + stderr;
    if (!out) out = "(no output)";

    const header = exitCode !== 0 ? `[exit ${exitCode}]\n` : "";
    // 9.1: strip progress/duplicate/passing-test noise BEFORE the oversize
    // check — filtered output often fits where raw would spill to disk.
    return persistOversized(header + filterCommandOutput(out), "command");
  } catch (e) {
    return `Error running command: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ─── Tool: web_fetch ─────────────────────────────────────────────────────────

interface WebFetchArgs {
  url: string;
  format?: "text" | "html";
  timeout?: number; // seconds, default 30
}

async function webFetch(args: WebFetchArgs): Promise<string> {
  const { url, format = "text", timeout = 30 } = args;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout * 1_000);
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { "User-Agent": "KlaatAI-CLI/0.1.0 (coding assistant)" },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) return `Error: Request to ${url} failed (HTTP ${response.status}).`;
    const body = await response.text();
    if (format === "html") return persistOversized(body, "webfetch");
    // Strip HTML tags → plain readable text
    return persistOversized(
      body
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim(),
      "webfetch"
    );
  } catch (e) {
    return `Error fetching ${url}: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ─── Tool: web_search ────────────────────────────────────────────────────────

interface WebSearchArgs {
  query: string;
  max_results?: number;
}

async function webSearch(args: WebSearchArgs, client?: KlaatAIClient | null): Promise<string> {
  const { query, max_results = 8 } = args;

  // Preferred: server-side search (Tavily proxy via Klaatu) — real search index.
  if (client) {
    const remote = await client.webSearch(query, max_results);
    if (remote && remote.results.length > 0) {
      const lines: string[] = [];
      if (remote.answer) lines.push(`**Answer**: ${remote.answer}`, "");
      for (const r of remote.results.slice(0, max_results)) {
        lines.push(`• ${r.title ?? r.url ?? "(untitled)"}\n  ${r.url ?? ""}${r.content ? `\n  ${r.content.slice(0, 300)}` : ""}`);
      }
      return truncate(lines.join("\n"));
    }
  }

  // Fallback: DuckDuckGo instant-answer API (no key required, weak coverage).
  const encoded = encodeURIComponent(query);
  const url = `https://api.duckduckgo.com/?q=${encoded}&format=json&no_html=1&skip_disambig=1&no_redirect=1`;

  interface DDGTopic { Text?: string; FirstURL?: string; Topics?: DDGTopic[] }
  interface DDGResponse {
    AbstractText?: string; AbstractURL?: string; AbstractSource?: string;
    RelatedTopics?: DDGTopic[]; Results?: DDGTopic[];
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let data: DDGResponse;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "KlaatAI-CLI/0.1.0" },
        signal: controller.signal,
      });
      data = await res.json() as DDGResponse;
    } finally {
      clearTimeout(timer);
    }

    const lines: string[] = [];
    if (data.AbstractText) {
      lines.push(`**${data.AbstractSource ?? "Summary"}**: ${data.AbstractText}`);
      if (data.AbstractURL) lines.push(`Source: ${data.AbstractURL}`);
      lines.push("");
    }

    let count = 0;
    for (const bucket of [data.Results ?? [], data.RelatedTopics ?? []]) {
      for (const t of bucket) {
        if (count >= max_results) break;
        if (t.Text && t.FirstURL) {
          lines.push(`• ${t.Text}\n  ${t.FirstURL}`);
          count++;
        } else if (t.Topics) {
          for (const st of t.Topics) {
            if (count >= max_results) break;
            if (st.Text && st.FirstURL) {
              lines.push(`• ${st.Text}\n  ${st.FirstURL}`);
              count++;
            }
          }
        }
      }
    }

    return lines.length
      ? truncate(lines.join("\n"))
      : `No results found for: ${query}. Try rephrasing the query.`;
  } catch (e) {
    return `Error searching "${query}": ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ─── Tool: todo_write / todo_read ────────────────────────────────────────────

const TODO_FILE = join(homedir(), ".klaatai", "todos.json");

interface TodoItem {
  id:       string;
  content:  string;
  status:   "pending" | "in_progress" | "completed" | "cancelled";
  priority: "high" | "medium" | "low";
}

interface TodoWriteArgs { todos: TodoItem[] }

function todoWrite(args: TodoWriteArgs): string {
  try {
    mkdirSync(dirname(TODO_FILE), { recursive: true });
    writeFileSync(TODO_FILE, JSON.stringify(args.todos, null, 2), "utf-8");
    const pending     = args.todos.filter(t => t.status === "pending").length;
    const in_progress = args.todos.filter(t => t.status === "in_progress").length;
    const completed   = args.todos.filter(t => t.status === "completed").length;
    return (
      `OK: Saved ${args.todos.length} todos ` +
      `(${pending} pending, ${in_progress} in_progress, ${completed} completed)`
    );
  } catch (e) {
    return `Error writing todos: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function todoRead(): string {
  try {
    if (!existsSync(TODO_FILE)) return "No todos found. Use todo_write to create tasks.";
    const todos = JSON.parse(readFileSync(TODO_FILE, "utf-8")) as TodoItem[];
    if (!todos.length) return "Todo list is empty.";
    const icons: Record<string, string> = {
      pending: "○", in_progress: "◉", completed: "✓", cancelled: "✗",
    };
    return todos
      .map(t => `${icons[t.status] ?? "?"} [${t.priority.toUpperCase()}] ${t.content}`)
      .join("\n");
  } catch (e) {
    return `Error reading todos: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ─── Graph tools ─────────────────────────────────────────────────────────────

function _fmtLocalSymbols(syms: LocalSymbol[]): string {
  return syms.map((s) => {
    const lines = [`## ${s.name} (${s.kind})`, `File: ${s.file}:${s.line}`];
    if (s.signature) lines.push(`Signature: ${s.signature}`);
    if (s.callers?.length) lines.push(`Called by: ${s.callers.join(", ")}`);
    if (s.callees?.length) lines.push(`Calls: ${s.callees.join(", ")}`);
    return lines.join("\n");
  }).join("\n\n");
}

async function graphQuery(
  args: { query: string; kind?: string; limit?: number },
  projectRoot: string,
  client: KlaatAIClient | null,
): Promise<string> {
  const proj = resolveProjectId(projectRoot);
  if (!proj) return "Error: Could not resolve project ID (no git remote found).";

  const query = args.query;
  const kind  = args.kind;
  const limit = args.limit ?? 10;

  // Local DB first — instant, no network.
  const local = localDbQuery(proj.id, query, kind, limit);
  if (local.length > 0) return _fmtLocalSymbols(local);

  // Server — enforces Pro plan.
  if (!client) return `No symbols found for "${query}". indexing runs automatically when the TUI opens this project — wait for the sidebar graph status, or sign in for server-side search.`;

  try {
    const res = await client.graphQuery(proj.id, query, kind, limit);
    if (res.status === 403 || res.status === 402) {
      return "Graph search requires a Pro plan. Upgrade at klaatai.com/pricing.";
    }
    if (res.status === 404) {
      return `Graph not found for this project. indexing runs automatically at TUI startup — it may still be in progress (see sidebar).`;
    }
    if (!res.ok) {
      return `Graph query failed. Please try again.`;
    }
    const data = await res.json() as {
      symbols?: Array<{
        name: string; kind: string; signature?: string; doc_comment?: string;
        file: string; start_line: number;
        callers: { name: string }[]; callees: { name: string }[];
      }>;
      partial?: boolean; indexed_ratio?: number;
    };
    if (!data.symbols?.length) return `No symbols found for "${query}". Try a different query or use grep.`;
    const lines: string[] = [];
    if (data.partial && data.indexed_ratio !== undefined)
      lines.push(`[Note: graph covers ${Math.round(data.indexed_ratio * 100)}% of project — results may be incomplete]\n`);
    for (const sym of data.symbols) {
      lines.push(`## ${sym.name} (${sym.kind})`);
      lines.push(`File: ${sym.file}:${sym.start_line}`);
      if (sym.signature)   lines.push(`Signature: ${sym.signature}`);
      if (sym.doc_comment) lines.push(`Doc: ${sym.doc_comment}`);
      if (sym.callers?.length) lines.push(`Called by: ${sym.callers.map((c) => c.name).join(", ")}`);
      if (sym.callees?.length) lines.push(`Calls: ${sym.callees.map((c) => c.name).join(", ")}`);
      lines.push("");
    }
    return lines.join("\n").trim();
  } catch (e) {
    return `project_graph_query failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function fileOutline(
  args: { path: string },
  projectRoot: string,
  client: KlaatAIClient | null,
): Promise<string> {
  const proj = resolveProjectId(projectRoot);
  if (!proj) return "Error: Could not resolve project ID.";
  const filePath = args.path;

  // Local DB first.
  const local = localDbFileSymbols(proj.id, filePath);
  if (local.length > 0) {
    const lines = local.map((s) => `${s.line}: ${s.name} (${s.kind})${s.signature ? ` — ${s.signature}` : ""}`);
    return `Outline for ${filePath}:\n${lines.join("\n")}`;
  }

  if (!client) return `File '${filePath}' not in local index. indexing runs automatically at TUI startup and may still be in progress.`;

  try {
    const res = await client.graphOutline(proj.id, filePath);
    if (res.status === 403 || res.status === 402) return "File outline from graph requires a Pro plan.";
    if (res.status === 404) return `File '${filePath}' not in graph. Use read_file to inspect it directly.`;
    if (!res.ok) {
      return `File outline failed. Please try again.`;
    }
    const data = await res.json() as { symbols?: { name: string; kind: string; line: number; signature?: string }[] };
    if (!data.symbols?.length) return `No symbols in graph for '${filePath}'.`;
    const lines = data.symbols.map((s) => `${s.line}: ${s.name} (${s.kind})${s.signature ? ` — ${s.signature}` : ""}`);
    return `Outline for ${filePath}:\n${lines.join("\n")}`;
  } catch (e) {
    return `file_outline failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function impactCheck(
  args: { symbol: string; file?: string },
  projectRoot: string,
  client: KlaatAIClient | null,
): Promise<string> {
  const proj = resolveProjectId(projectRoot);
  if (!proj) return "Error: Could not resolve project ID.";
  const symbol = args.symbol;

  // Local BFS first.
  const local = localDbCallers(proj.id, symbol);
  if (local.length > 0) {
    const lines = [
      `Blast radius for "${symbol}": ${local.length} caller(s)`,
      "",
      ...local.map((c) => `  [hop ${c.hop}] ${c.callerName} — ${c.callerFile}`),
    ];
    return lines.join("\n");
  }

  if (!client) return `No callers found for "${symbol}" in local index. indexing runs automatically at TUI startup and may still be in progress.`;

  try {
    const res = await client.graphImpact(proj.id, symbol, args.file);
    if (res.status === 403 || res.status === 402) return "Impact check requires a Pro plan. Upgrade at klaatai.com/pricing.";
    if (!res.ok) {
      return `Impact check failed. Please try again.`;
    }
    const data = await res.json() as {
      symbol: string;
      callers: { caller_name: string; caller_file: string; caller_line: number; hop: number }[];
      blast_radius: number;
    };
    if (!data.callers?.length) return `No callers found for "${symbol}". Safe to modify in isolation.`;
    const lines = [
      `Blast radius for "${data.symbol}": ${data.blast_radius} caller(s)`,
      "",
      ...data.callers.map((c) => `  [hop ${c.hop}] ${c.caller_name} — ${c.caller_file}:${c.caller_line}`),
    ];
    return lines.join("\n");
  } catch (e) {
    return `impact_check failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function semanticSearch(
  args: { query: string; limit?: number },
  projectRoot: string,
  client: KlaatAIClient | null,
): Promise<string> {
  const query = args.query || "";
  if (!query) return "project_semantic_search: \"query\" argument is required";

  const proj = resolveProjectId(projectRoot);
  if (!proj) return "project_semantic_search: no project indexed yet — indexing runs automatically at TUI startup and may still be in progress.";

  if (!client) return "project_semantic_search: not authenticated — run \"klaatai login\" first.";

  try {
    const queryVec = await embedQuery(query, client.token, client.serverUrl);
    const limit = args.limit ?? 15;
    const results = localDbSemanticSearch(proj.id, queryVec, limit);

    if (results.length === 0) {
      return `Semantic search: no results for "${query}". Embeddings may still be generating after indexing. Try project_graph_query for exact name search in the meantime.`;
    }

    const lines = [`Semantic search for "${query}" (${results.length} results):`];
    for (const r of results) {
      lines.push(`  ${r.kind} ${r.name} — ${r.file}:${r.line} (${(r.score * 100).toFixed(0)}% relevant)`);
    }
    return lines.join("\n");
  } catch (e) {
    return `project_semantic_search failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ─── Tool: plan_exploration (9.2) ────────────────────────────────────────────

function planExploration(
  args: { task?: string; max_files?: number },
  projectRoot: string,
): string {
  const task = args.task?.trim();
  if (!task) return "plan_exploration: \"task\" argument is required";
  const proj = resolveProjectId(projectRoot);
  if (!proj) {
    return "plan_exploration: no project index available — explore with file_outline/grep instead.";
  }
  const graph: GraphAccess = {
    query: (kw, limit) =>
      localDbQuery(proj.id, kw, undefined, limit).map(s => ({
        name: s.name, kind: s.kind, file: s.file, line: s.line,
      })),
    callers: (name) => localDbCallers(proj.id, name, 1),
  };
  try {
    const steps = buildPlan(task, graph, args.max_files);
    return renderPlan(task, steps);
  } catch (e) {
    return `plan_exploration failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────

/** Execute a model-issued tool call and return the string result. */
export async function executeTools(tc: ToolCall, projectRoot: string, client?: KlaatAIClient): Promise<string> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
  } catch {
    return `Error: Could not parse arguments for tool "${tc.function.name}"`;
  }

  switch (tc.function.name) {
    case "read_file":    return readFile(args as unknown as ReadFileArgs, projectRoot);
    case "write_file":   return writeFile(args as unknown as WriteFileArgs, projectRoot);
    case "edit_file":    return editFile(args as unknown as EditFileArgs, projectRoot);
    case "multi_edit":   return multiEdit(args as unknown as MultiEditArgs, projectRoot);
    case "apply_patch":  return applyPatch(args as unknown as ApplyPatchArgs, projectRoot);
    case "glob":         return globFiles(args as unknown as GlobArgs, projectRoot);
    case "grep":         return grepFiles(args as unknown as GrepArgs, projectRoot);
    case "list_dir":     return listDir(args as unknown as ListDirArgs, projectRoot);
    case "run_command":  return runCommand(args as unknown as RunCommandArgs, projectRoot);
    case "shell_output": return filterCommandOutput(readBackground(String((args as { id?: string }).id ?? "")));
    case "shell_kill":   return killBackground(String((args as { id?: string }).id ?? ""));
    case "web_fetch":    return webFetch(args as unknown as WebFetchArgs);
    case "web_search":   return webSearch(args as unknown as WebSearchArgs, client);
    case "todo_write":   return todoWrite(args as unknown as TodoWriteArgs);
    case "todo_read":    return todoRead();
    case "project_graph_query":
      return graphQuery(args as { query: string; kind?: string; limit?: number }, projectRoot, client ?? null);
    case "file_outline":
      return fileOutline(args as { path: string }, projectRoot, client ?? null);
    case "impact_check":
      return impactCheck(args as { symbol: string; file?: string }, projectRoot, client ?? null);
    case "plan_exploration":
      return planExploration(args as { task?: string; max_files?: number }, projectRoot);
    case "project_semantic_search":
      return semanticSearch(args as { query: string; limit?: number }, projectRoot, client ?? null);
    case "browser_navigate":
      return browserSession.navigate(String(args.url ?? ""));
    case "browser_get_state":
      return Promise.resolve(browserSession.getState());
    case "browser_get_text":
      return Promise.resolve(browserSession.getText());
    case "browser_click":
      return browserSession.click({ index: args.index as number | undefined, text: args.text as string | undefined });
    case "browser_get_links":
      return Promise.resolve(browserSession.getLinks());
    default:
      return `Error: Unknown tool "${tc.function.name}"`;
  }
}

// ─── Tool Definitions (sent to model) ────────────────────────────────────────

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a file's contents with line numbers. Use offset+limit for large files. " +
        "If called on a directory, lists its contents instead.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path relative to project root, or absolute.",
          },
          offset: {
            type: "integer",
            description: "First line to return (1-indexed). Default: 1.",
          },
          limit: {
            type: "integer",
            description: "Maximum number of lines to return. Default: 200.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Write content to a file, overwriting it. Creates parent directories automatically. " +
        "Prefer edit_file for targeted changes to existing files.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path relative to project root, or absolute.",
          },
          content: {
            type: "string",
            description: "Full file content to write.",
          },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Replace a string in an existing file. old_string should match the file text exactly " +
        "(minor whitespace/indentation differences are tolerated) and identify one unique location " +
        "unless replace_all is true. Use read_file first to confirm the exact text. " +
        "Prefer this over write_file for targeted edits.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path relative to project root, or absolute.",
          },
          old_string: {
            type: "string",
            description:
              "The text to find. Should be unique in the file — include surrounding lines for context if needed.",
          },
          new_string: {
            type: "string",
            description: "The replacement text.",
          },
          replace_all: {
            type: "boolean",
            description: "Replace every occurrence instead of requiring a unique match. Default false.",
          },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "multi_edit",
      description:
        "Apply several string replacements to ONE file atomically — all edits succeed or none are written. " +
        "Edits are applied in order, each operating on the result of the previous. " +
        "Prefer this over multiple edit_file calls when changing several places in the same file.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path relative to project root, or absolute.",
          },
          edits: {
            type: "array",
            description: "The replacements to apply, in order.",
            items: {
              type: "object",
              properties: {
                old_string: { type: "string", description: "The text to find (unique unless replace_all)." },
                new_string: { type: "string", description: "The replacement text." },
                replace_all: { type: "boolean", description: "Replace every occurrence. Default false." },
              },
              required: ["old_string", "new_string"],
            },
          },
        },
        required: ["path", "edits"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "apply_patch",
      description:
        "Apply a multi-file patch atomically (all files succeed or none change). Use for changes spanning " +
        "several files, or that create/delete/rename files in one shot. Envelope format:\n" +
        "*** Begin Patch\n*** Add File: path\n+new content\n*** Update File: path\n@@\n context\n-old\n+new\n" +
        "*** Delete File: path\n*** End Patch\n" +
        "Update hunks match fuzzily. For a single simple edit, prefer edit_file.",
      parameters: {
        type: "object",
        properties: {
          patch: { type: "string", description: "The full patch text, from '*** Begin Patch' to '*** End Patch'." },
        },
        required: ["patch"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      description:
        "Find files matching a glob pattern. Returns paths relative to the search directory. " +
        "Examples: '**/*.ts', 'src/**/*.tsx', '*.json'.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Glob pattern to match.",
          },
          path: {
            type: "string",
            description: "Directory to search. Default: project root.",
          },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description:
        "Search file contents using a regex pattern. Returns file:line:match lines. " +
        "Use include to narrow the file types searched.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Regex pattern to search for.",
          },
          path: {
            type: "string",
            description: "Directory to search. Default: project root.",
          },
          include: {
            type: "string",
            description: "File glob filter, e.g. '*.ts', '*.{ts,tsx}'. Default: all files.",
          },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description:
        "List files and subdirectories in a directory. " +
        "Subdirectories are shown with a trailing '/'.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory path relative to project root, or absolute.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a shell command in a subprocess. Use for builds, tests, git operations, installs, etc. " +
        "stdout and stderr are both captured and returned. For long-running processes (dev servers, " +
        "watchers), set background:true and poll with shell_output.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Shell command to run (passed to sh -c).",
          },
          workdir: {
            type: "string",
            description: "Working directory. Default: project root.",
          },
          timeout: {
            type: "integer",
            description: "Timeout in seconds (foreground only). Default: 30. Max recommended: 120.",
          },
          background: {
            type: "boolean",
            description: "Run detached in the background; returns a shell id immediately. Use for dev servers / long watchers.",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shell_output",
      description: "Read new output from a background shell started by run_command (background:true). Returns output since the last poll + status.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "The shell id returned by run_command." } },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shell_kill",
      description: "Stop a background shell by id.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "The shell id to kill." } },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description:
        "Fetch a URL and return its content as plain text (HTML tags stripped). " +
        "Use to read documentation, GitHub files, API responses, or any web resource. " +
        "Use format='html' to get raw HTML.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Full URL to fetch (must include https:// or http://).",
          },
          format: {
            type: "string",
            enum: ["text", "html"],
            description: "Output format. 'text' (default) strips HTML tags; 'html' returns raw HTML.",
          },
          timeout: {
            type: "integer",
            description: "Timeout in seconds. Default: 30.",
          },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web using DuckDuckGo and return result snippets with URLs. " +
        "Use for looking up documentation, error messages, libraries, or any factual information.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query.",
          },
          max_results: {
            type: "integer",
            description: "Maximum number of results to return. Default: 8.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todo_write",
      description:
        "Write the current task list. Call this whenever you start a new task, complete one, " +
        "or when the user asks you to track work items. Replaces the entire todo list. " +
        "Use todo_read to see the current list before updating.",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            description: "The complete updated todo list.",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Unique short identifier, e.g. '1', 'auth-fix'." },
                content: { type: "string", description: "Task description." },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed", "cancelled"],
                  description: "Current status. Only one task should be in_progress at a time.",
                },
                priority: {
                  type: "string",
                  enum: ["high", "medium", "low"],
                  description: "Task priority.",
                },
              },
              required: ["id", "content", "status", "priority"],
            },
          },
        },
        required: ["todos"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todo_read",
      description: "Read the current todo list. Call this before todo_write to see existing tasks.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_user",
      description:
        "Ask the user a multiple-choice question when you genuinely need a decision only they can make " +
        "(ambiguous requirement, a choice between real approaches). Do NOT use for things you can decide " +
        "with sensible defaults or verify from the code. The user's selection is returned as the result.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "The question to ask. Be specific." },
          options: {
            type: "array",
            description: "2–4 distinct choices. Put a recommended option first.",
            items: { type: "string" },
          },
          allow_multiple: { type: "boolean", description: "Allow selecting more than one option. Default false." },
        },
        required: ["question", "options"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delegate_task",
      description:
        "Delegate a focused sub-task to a specialized agent with an isolated context. " +
        "Only the agent's final report returns to this conversation — its exploration stays out of your context, " +
        "so use it for anything search- or read-heavy. " +
        "Multiple explore/review delegations issued in the same turn run in PARALLEL. " +
        "Agents: 'explore' (read-only search/exploration — default choice), 'review' (read-only code review), " +
        "'build' (can edit files and run commands), 'general' (all tools).",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "The specific task for the sub-agent to accomplish. Be precise and self-contained — the agent cannot see this conversation.",
          },
          agent: {
            type: "string",
            enum: ["explore", "review", "build", "general"],
            description: "Which agent persona to use. Default: general. Prefer explore/review for read-only work — they run without prompts and in parallel.",
          },
          context: {
            type: "string",
            description:
              "Additional context the sub-agent needs: file paths, requirements, constraints. " +
              "Include anything relevant from this conversation — the agent starts blank.",
          },
          tier: {
            type: "string",
            enum: ["nano", "fast", "code", "reason", "heavy"],
            description: "Optional routing-tier override (each persona has a sensible default).",
          },
          background: {
            type: "boolean",
            description:
              "Set true to run this agent in the BACKGROUND: returns a task id immediately so you can keep working. " +
              "Poll with task_status(id); you also get a note in the conversation when it finishes. " +
              "Use for long explorations or independent side-work — do NOT sit idle waiting for it.",
          },
        },
        required: ["task"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "task_status",
      description:
        "Check background agents started with delegate_task background:true. " +
        "Without id: list all background tasks and their status. " +
        "With id: live output tail while running, or the agent's final report once done.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Background task id (e.g. \"task-1\"). Omit to list all tasks.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "project_graph_query",
      description:
        "Query the project code graph for symbols, relationships, and structure.\n\n" +
        "ALWAYS call this BEFORE read_file or grep for any code-navigation question: where a function is " +
        "defined, what calls a class, which files handle a concern, or exploring unfamiliar code. It returns " +
        "exact file:line locations AND caller/callee relationships in one call, so you read only what you need " +
        "— far cheaper than multiple grep+read cycles.\n\n" +
        "Results are ranked by reference count (most-used symbols first). If the graph is not yet indexed or " +
        "returns nothing for your query, THEN fall back to grep/read_file.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Symbol name or natural-language target. Examples: 'processPayment', 'auth module', 'database connection handling'.",
          },
          kind: {
            type: "string",
            enum: ["function", "method", "class", "interface", "type", "enum", "variable", "all"],
            description: "Filter by symbol kind. Omit or use 'all' to search all kinds.",
          },
          limit: {
            type: "number",
            description: "Max results to return (1–30, default 10).",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_outline",
      description:
        "Get a structured outline of a file — symbol names, kinds, signatures, and line numbers.\n\n" +
        "Use this INSTEAD OF read_file when you need to know what's in a file but not its full content. " +
        "Costs ~200 tokens vs 2,000+ for read_file. Typical flow:\n" +
        "  1. file_outline('src/auth/oauth.ts')  → see all functions + signatures\n" +
        "  2. read_file('src/auth/oauth.ts', offset=42, limit=30)  → read only the part you need",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative path to the file (from project root).",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "impact_check",
      description:
        "Check what would be affected by changing a symbol — its blast radius.\n\n" +
        "Run this BEFORE editing any exported function, class, or interface. Returns direct and indirect " +
        "callers (up to a few hops) so you know how widely a change propagates and what to re-verify. " +
        "Cheaper and more complete than grepping for every call site.",
      parameters: {
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description: "The function, method, or class name to analyse.",
          },
          file: {
            type: "string",
            description: "Optional: narrow search to a specific file path.",
          },
        },
        required: ["symbol"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "project_semantic_search",
      description:
        "Search the codebase by MEANING, not just symbol names. Use when you know what you want " +
        "(e.g. \"authentication error handling\", \"database connection setup\", \"email sender\") but not the " +
        "exact name — this finds it where grep/graph-query by name would miss. Returns ranked results with " +
        "relevance scores. If it returns nothing, fall back to project_graph_query or grep.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Natural language description of the code you're looking for.",
          },
          limit: {
            type: "number",
            description: "Maximum results to return (default 15).",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "plan_exploration",
      description:
        "Plan the optimal file-read order for a task BEFORE reading anything. Returns an ordered " +
        "list of files with a read depth for each (outline / targeted section / full read) derived " +
        "from the code graph: files named in the task, files defining matched symbols, and their " +
        "callers. Call this FIRST on any task touching more than one file, then follow the plan — " +
        "it is far cheaper than reading files in discovery order.",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "The task to plan exploration for, in full — include identifiers, file names, and error text verbatim.",
          },
          max_files: {
            type: "number",
            description: "Maximum files in the plan (default 8).",
          },
        },
        required: ["task"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_navigate",
      description:
        "Navigate to a URL and return the page title, link count, and a text preview. " +
        "Use this to open web pages for research or documentation.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Full URL starting with http:// or https://" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_get_state",
      description: "Return the current page URL, title, link count, and a short text preview.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_get_text",
      description:
        "Return the full readable text content of the currently loaded page (up to 20,000 chars).",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_click",
      description:
        "Follow a link on the current page by index number or by matching link text. " +
        "Use browser_get_state first to see available links.",
      parameters: {
        type: "object",
        properties: {
          index: { type: "number", description: "Link index from browser_get_state (1-based)" },
          text: { type: "string", description: "Partial link text to match (case-insensitive)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_get_links",
      description: "List up to 50 links on the current page with their index numbers and URLs.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
];
