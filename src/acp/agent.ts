/**
 * ACP agent — translates the agentic loop already running for the TUI/`run`
 * (stream → tool calls → permission → execute → repeat) into ACP's
 * `session/update` notification stream + `session/request_permission`
 * round-trips. This is a mapping layer, not new agent capability: the loop
 * shape mirrors headless-agent.ts (used by `klaatai bench`), with streaming
 * per-chunk emission and real permission prompts routed to the editor
 * instead of headless's auto-allow-everything.
 *
 * Cut from v1 (documented, not silent gaps):
 *   - Session ledger / collapse-check (9.6) — compaction is destructive here
 *     exactly like the TUI's own apiMessages, just without the recovery net.
 *   - fs/read_text_file, fs/write_text_file, terminal/* (client capabilities)
 *     — our tools do direct file/process I/O; these would only add value for
 *     editor-buffer-aware reads of unsaved changes.
 *   - session/load, session/set_mode, multi-session listing — session/new +
 *     session/prompt + session/cancel cover what ACP editors drive today.
 *   - True mid-stream cancellation: session/cancel is cooperative (checked
 *     between chunks/tool calls), not a hard fetch abort.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KlaatAIClient, type Message, type ToolCall, type ToolDefinition } from "../api/client.js";
import { executeTools, TOOL_DEFINITIONS, configureSandbox, safeResolve } from "../tools/index.js";
import { setOutputFilterEnabled } from "../tools/output-filter.js";
import { configureDiagnostics } from "../tools/diagnostics.js";
import { KGIndexer } from "../tools/kg-indexer.js";
import { initLocalDb } from "../tools/local-db.js";
import { compactMessagesForApi } from "../agent/compaction.js";
import { seedSystemMessages } from "../agent/system-prompt.js";
import { stripStrayTextToolCallArtifacts } from "../agent/text-tool-artifacts.js";
import {
  checkPermission, loadPermissions, persistAlwaysAllow, SAFE_TOOLS,
  type PermDecision, type PermissionsFile,
} from "../permissions/index.js";
import { resolveProjectId } from "../utils/project-id.js";
import { loadConfig } from "../auth/credentials.js";
import { getValidAuthToken } from "../auth/refresh.js";
import { version as VERSION } from "../../package.json";
import { AcpConnection } from "./connection.js";
import {
  ACP_PROTOCOL_VERSION,
  type CancelParams, type ContentBlock, type InitializeParams, type InitializeResult,
  type NewSessionParams, type NewSessionResult, type PermissionOption,
  type PromptParams, type PromptResult, type RequestPermissionResult,
  type SessionUpdate, type StopReason, type ToolCallContent, type ToolCallLocation, type ToolKind,
} from "./types.js";

// Background sub-agents (delegate_task/task_status) aren't wired into
// executeTools() either — headless-agent.ts (bench) has the same gap, noted
// there as "later `run --agent` and background sub-agents (3.3)".
const AGENT_TOOLS: ToolDefinition[] = TOOL_DEFINITIONS.filter(
  t => t.function.name !== "delegate_task" && t.function.name !== "task_status",
);

const TOOL_KIND: Record<string, ToolKind> = {
  read_file: "read", file_outline: "read", list_dir: "read", shell_output: "read",
  write_file: "edit", edit_file: "edit", multi_edit: "edit", apply_patch: "edit",
  run_command: "execute", shell_kill: "execute",
  glob: "search", grep: "search", project_graph_query: "search",
  project_semantic_search: "search", impact_check: "search",
  web_fetch: "fetch", web_search: "fetch",
  todo_write: "think", todo_read: "think", plan_exploration: "think",
};
function toolKind(name: string): ToolKind { return TOOL_KIND[name] ?? "other"; }

function toolTitle(name: string, args: Record<string, unknown>): string {
  const p = typeof args["path"] === "string" ? args["path"] : undefined;
  switch (name) {
    case "read_file":   return `Read ${p ?? "file"}`;
    case "write_file":  return `Write ${p ?? "file"}`;
    case "edit_file":
    case "multi_edit":  return `Edit ${p ?? "file"}`;
    case "apply_patch": return "Apply patch";
    case "list_dir":    return `List ${p ?? "directory"}`;
    case "run_command": return typeof args["command"] === "string" ? `Run: ${args["command"]}` : "Run command";
    case "grep":         return `Search: ${String(args["pattern"] ?? "")}`;
    case "glob":          return `Find files: ${String(args["pattern"] ?? "")}`;
    case "web_fetch":    return `Fetch ${String(args["url"] ?? "")}`;
    case "web_search":   return `Search web: ${String(args["query"] ?? "")}`;
    case "todo_write":   return "Update plan";
    default: return name.replace(/_/g, " ");
  }
}

function textContent(text: string): ToolCallContent {
  return { type: "content", content: { type: "text", text } };
}

function blockToText(b: ContentBlock): string {
  if (b.type === "text" && "text" in b) return (b as { text: string }).text;
  if (b.type === "resource_link" && "uri" in b) {
    const rl = b as { uri: string; name?: string };
    return `[Referenced: ${rl.name ?? rl.uri}](${rl.uri})`;
  }
  return "";
}

function safeRead(path: string): string {
  try { return readFileSync(path, "utf-8"); } catch { return ""; }
}

interface SessionState {
  projectRoot: string;
  messages: Message[];
  cancelled: boolean;
}

export class AcpAgent {
  private client: KlaatAIClient | null = null;
  private sessions = new Map<string, SessionState>();
  private busy: Promise<unknown> = Promise.resolve();

  constructor(private readonly conn: AcpConnection) {
    conn.onRequest("initialize", (p) => this.initialize(p as InitializeParams));
    conn.onRequest("session/new", (p) => this.sessionNew(p as NewSessionParams));
    conn.onRequest("session/prompt", (p) => this.enqueue(() => this.sessionPrompt(p as PromptParams)));
    conn.onNotification("session/cancel", (p) => this.sessionCancel(p as CancelParams));
  }

  /** Serialize prompt handling — one agent loop at a time, same as the TUI. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.busy.then(fn, fn);
    this.busy = run.then(() => {}, () => {});
    return run;
  }

  private async initialize(params: InitializeParams): Promise<InitializeResult> {
    const apiKey = process.env["KLAATAI_API_KEY"] ?? await getValidAuthToken();
    if (!apiKey) throw new Error("Not signed in — run `klaatai login` first, then reconnect your editor.");

    const config = loadConfig();
    this.client = new KlaatAIClient({ apiKey, baseUrl: config.baseUrl });
    configureDiagnostics({ enabled: config.diagnostics !== "off", commands: config.diagnosticsCommands });
    setOutputFilterEnabled(config.outputFilter !== "off");

    return {
      protocolVersion: Math.min(params.protocolVersion ?? ACP_PROTOCOL_VERSION, ACP_PROTOCOL_VERSION),
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        mcpCapabilities: { http: false, sse: false },
      },
      authMethods: [],
      agentInfo: { name: "klaatcode", version: VERSION },
    };
  }

  private async sessionNew(params: NewSessionParams): Promise<NewSessionResult> {
    if (!this.client) throw new Error("initialize must be called first");
    const projectRoot = params.cwd;
    const sessionId = randomUUID();
    this.sessions.set(sessionId, {
      projectRoot,
      messages: seedSystemMessages(projectRoot),
      cancelled: false,
    });

    // Sandbox is process-global state, rooted at THIS session's workspace —
    // correct as long as one prompt runs at a time (enqueue() guarantees
    // that), which covers every ACP editor's actual usage pattern (one
    // agent subprocess per open workspace).
    const config = loadConfig();
    configureSandbox({
      enabled: config.sandbox !== "off",
      root: projectRoot,
      allow: [join(homedir(), ".klaatai"), ...(config.sandboxAllow ?? [])],
    });

    // Background code-graph indexing — same as the TUI and `run`, so
    // project_graph_query/plan_exploration/impact_check aren't empty on a
    // freshly opened editor session. Fire-and-forget; degrades gracefully
    // (free tier / offline) exactly like every other client.
    initLocalDb();
    const proj = resolveProjectId(projectRoot);
    if (proj) {
      this.client.setProjectId(proj.id);
      void new KGIndexer(this.client).indexWorkspace(projectRoot);
    }

    return { sessionId };
  }

  private sessionCancel(params: CancelParams): void {
    const s = this.sessions.get(params.sessionId);
    if (s) s.cancelled = true;
  }

  private notifyUpdate(sessionId: string, update: SessionUpdate): void {
    this.conn.notify("session/update", { sessionId, update });
  }

  private async requestPermission(
    sessionId: string, tc: ToolCall, kind: ToolKind, title: string, locations?: ToolCallLocation[],
  ): Promise<PermDecision> {
    const options: PermissionOption[] = [
      { optionId: "allow_once",   name: "Allow",                         kind: "allow_once" },
      { optionId: "allow_always", name: `Always allow ${tc.function.name}`, kind: "allow_always" },
      { optionId: "deny",         name: "Deny",                          kind: "reject_once" },
    ];
    const res = await this.conn.request("session/request_permission", {
      sessionId,
      toolCall: { sessionUpdate: "tool_call_update", toolCallId: tc.id, title, kind, locations },
      options,
    }) as RequestPermissionResult;

    if (res.outcome.outcome === "cancelled") return "deny";
    if (res.outcome.optionId === "allow_always") return "allow_always";
    if (res.outcome.optionId === "deny") return "deny";
    return "allow_once";
  }

  private emitPlan(sessionId: string, args: Record<string, unknown>): void {
    const todos = Array.isArray(args["todos"])
      ? args["todos"] as Array<{ content?: string; status?: string; priority?: string }>
      : [];
    if (!todos.length) return;
    this.notifyUpdate(sessionId, {
      sessionUpdate: "plan",
      entries: todos.map(t => ({
        content: String(t.content ?? ""),
        priority: t.priority === "high" || t.priority === "low" ? t.priority : "medium",
        status: t.status === "in_progress" ? "in_progress"
          : t.status === "completed" || t.status === "cancelled" ? "completed"
          : "pending",
      })),
    });
  }

  private async runTool(
    sessionId: string, projectRoot: string, client: KlaatAIClient, tc: ToolCall,
    perms: PermissionsFile, sessionApproved: Set<string>,
  ): Promise<string> {
    const name = tc.function.name;
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(tc.function.arguments) as Record<string, unknown>; } catch { /* tool reports its own parse error */ }

    const kind = toolKind(name);
    const path = typeof args["path"] === "string" ? safeResolve(projectRoot, args["path"]) : undefined;
    const locations: ToolCallLocation[] | undefined = path ? [{ path }] : undefined;
    const title = toolTitle(name, args);

    this.notifyUpdate(sessionId, { sessionUpdate: "tool_call", toolCallId: tc.id, title, kind, status: "pending", locations });

    const isSafe = SAFE_TOOLS.has(name) || name === "todo_write";
    if (!isSafe && !sessionApproved.has(name)) {
      const check = checkPermission(tc, perms);
      if (check === "deny") {
        this.notifyUpdate(sessionId, { sessionUpdate: "tool_call_update", toolCallId: tc.id, status: "failed", content: [textContent("Permission denied (matched a deny rule).")] });
        return "Error: Permission denied (matched deny rule).";
      }
      if (check === "ask") {
        const decision = await this.requestPermission(sessionId, tc, kind, title, locations);
        if (decision === "deny") {
          this.notifyUpdate(sessionId, { sessionUpdate: "tool_call_update", toolCallId: tc.id, status: "failed", content: [textContent("User denied permission for this tool call.")] });
          return "Error: User denied permission for this tool call.";
        }
        sessionApproved.add(name);
        if (decision === "allow_always") persistAlwaysAllow(tc);
      }
    }

    this.notifyUpdate(sessionId, { sessionUpdate: "tool_call_update", toolCallId: tc.id, status: "in_progress" });

    // Before/after diff for edit-kind tools — richer than a text dump, and
    // how Zed renders inline diffs. Single-path tools only (multi_edit has
    // one, apply_patch can touch several — that one falls back to text).
    const oldText = kind === "edit" && name !== "apply_patch" && path && existsSync(path) ? safeRead(path) : null;
    const result = await executeTools(tc, projectRoot, client);
    const failed = /^Error[:\s]/i.test(result);

    let content: ToolCallContent[];
    if (kind === "edit" && name !== "apply_patch" && path && !failed) {
      const newText = existsSync(path) ? safeRead(path) : "";
      content = oldText !== newText ? [{ type: "diff", path, oldText, newText }] : [textContent(result)];
    } else {
      content = [textContent(result)];
    }

    this.notifyUpdate(sessionId, { sessionUpdate: "tool_call_update", toolCallId: tc.id, status: failed ? "failed" : "completed", content });

    if (name === "todo_write") this.emitPlan(sessionId, args);
    return result;
  }

  private async sessionPrompt(params: PromptParams): Promise<PromptResult> {
    const state = this.sessions.get(params.sessionId);
    if (!state) throw new Error(`Unknown session: ${params.sessionId}`);
    if (!this.client) throw new Error("initialize must be called first");
    const client = this.client;
    state.cancelled = false;

    const userText = params.prompt.map(blockToText).filter(Boolean).join("\n");
    state.messages.push({ role: "user", content: userText });

    const perms = loadPermissions();
    const sessionApproved = new Set<string>();
    const config = loadConfig();
    const maxTurns = 60; // editor sessions run longer than a single bench task
    let turns = 0;
    let loopRefusals = 0;

    while (turns < maxTurns) {
      if (state.cancelled) return { stopReason: "cancelled" as StopReason };

      if (state.messages.length > 8) {
        state.messages = compactMessagesForApi(state.messages, undefined, { attentionOrder: config.attentionOrder !== "off" });
      }

      const messageId = randomUUID();
      let fullText = "";
      let pendingToolCalls: ToolCall[] | null = null;
      let loopSignal: { count: number; results_identical?: boolean } | null = null;

      for await (const chunk of client.chatStream(state.messages, { tools: AGENT_TOOLS })) {
        if (state.cancelled) return { stopReason: "cancelled" as StopReason };
        if (chunk.type === "token" && chunk.text) {
          fullText += chunk.text;
          this.notifyUpdate(params.sessionId, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: chunk.text },
          });
          void messageId; // reserved: per-message id once ACP message coalescing is worth adding
        } else if (chunk.type === "tool_call") {
          pendingToolCalls = chunk.tool_calls ?? null;
        } else if (chunk.type === "metadata" && chunk.metadata) {
          loopSignal = chunk.metadata.loop_signal ?? null;
        } else if (chunk.type === "error") {
          throw new Error(chunk.error ?? "stream error");
        }
      }

      // Same cleanup the TUI applies to the committed message: some models
      // emit tool calls as text-embedded XML-ish syntax rather than a proper
      // tool_calls array; client.ts repairs those into real tool calls, but
      // leftover artifacts in the surrounding text (and the raw tags briefly
      // visible while streaming, same as the TUI) need stripping before this
      // text re-enters conversation history for the next turn.
      const cleaned = stripStrayTextToolCallArtifacts(
        fullText.replace(/<(?:thinking|reasoning)>[\s\S]*?<\/(?:thinking|reasoning)>/g, ""),
      ).trim();

      if (pendingToolCalls && pendingToolCalls.length) {
        turns += 1;
        state.messages.push({ role: "assistant", content: cleaned, tool_calls: pendingToolCalls });

        // 9.4: same doom-loop reaction as the TUI/headless — refuse identical
        // repeated rounds, give up after 3 (editor has no synchronous human
        // to intervene mid-refusal the way the TUI does).
        if (loopSignal?.results_identical) {
          loopRefusals++;
          if (loopRefusals >= 3) return { stopReason: "refusal" as StopReason };
          const guidance =
            `Refused: doom-loop detected — this exact tool round already ran ${loopSignal.count}+ times ` +
            `with identical results. Do NOT repeat it; change approach or finish with your best answer.`;
          for (const tc of pendingToolCalls) {
            state.messages.push({ role: "tool", content: guidance, tool_call_id: tc.id });
          }
          continue;
        }
        loopRefusals = 0;

        for (const tc of pendingToolCalls) {
          if (state.cancelled) return { stopReason: "cancelled" as StopReason };
          const result = await this.runTool(params.sessionId, state.projectRoot, client, tc, perms, sessionApproved);
          state.messages.push({ role: "tool", content: result.slice(0, 20_000), tool_call_id: tc.id });
        }
        continue;
      }

      state.messages.push({ role: "assistant", content: cleaned || fullText });
      return { stopReason: "end_turn" as StopReason };
    }

    return { stopReason: "max_turn_requests" as StopReason };
  }
}

/** Entry point for `klaatai acp` — runs until the editor closes the pipe. */
export function runAcpServer(): void {
  const conn = new AcpConnection(process.stdin, process.stdout);
  new AcpAgent(conn);
  process.stdin.resume();
  process.stdin.on("end", () => process.exit(0));
}
