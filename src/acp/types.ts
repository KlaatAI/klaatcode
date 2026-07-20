/**
 * ACP v1 wire types — the subset klaatai actually implements.
 * Source of truth: agentclientprotocol.com, schema/v1/schema.json in
 * agentclientprotocol/agent-client-protocol (fetched 2026-07-20).
 *
 * Not implemented (client-facing methods we don't call): fs/read_text_file,
 * fs/write_text_file, terminal/* — our tools already do direct file/process
 * I/O, so there's no gap; these would only matter for editor-buffer-aware
 * reads (unsaved changes) or embedding output in the editor's own terminal
 * panel. session/load, session/set_mode, session/list|delete|resume|close,
 * authenticate — session/new + session/prompt + session/cancel cover the
 * only flow ACP editors currently drive by default.
 */

export interface ContentBlockText { type: "text"; text: string }
export interface ContentBlockResourceLink { type: "resource_link"; uri: string; name: string }
export interface ContentBlockImage { type: "image"; data: string; mimeType: string; uri?: string }
export type ContentBlock = ContentBlockText | ContentBlockResourceLink | ContentBlockImage | { type: string };

export interface InitializeParams {
  protocolVersion: number;
  clientCapabilities?: { fs?: { readTextFile?: boolean; writeTextFile?: boolean }; terminal?: boolean };
  clientInfo?: { name: string; version?: string };
}

export const ACP_PROTOCOL_VERSION = 1;

export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities: {
    loadSession: boolean;
    promptCapabilities: { image: boolean; audio: boolean; embeddedContext: boolean };
    mcpCapabilities: { http: boolean; sse: boolean };
  };
  authMethods: [];
  agentInfo: { name: string; version: string };
}

export interface NewSessionParams {
  cwd: string;
  mcpServers: unknown[];
  additionalDirectories?: string[];
}

export interface NewSessionResult { sessionId: string }

export interface PromptParams { sessionId: string; prompt: ContentBlock[] }

export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";
export interface PromptResult { stopReason: StopReason }

export interface CancelParams { sessionId: string }

// ─── session/update (agent → client, notification) ──────────────────────────

export type ToolKind =
  | "read" | "edit" | "delete" | "move" | "search"
  | "execute" | "think" | "fetch" | "switch_mode" | "other";
export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

export interface ToolCallLocation { path: string; line?: number }
export type ToolCallContent =
  | { type: "content"; content: ContentBlock }
  | { type: "diff"; path: string; oldText: string | null; newText: string };

export interface ToolCallUpdate {
  sessionUpdate: "tool_call" | "tool_call_update";
  toolCallId: string;
  title?: string;
  kind?: ToolKind;
  status?: ToolCallStatus;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
}

export interface PlanEntry { content: string; priority: "high" | "medium" | "low"; status: "pending" | "in_progress" | "completed" }
export interface PlanUpdate { sessionUpdate: "plan"; entries: PlanEntry[] }

export interface ContentChunkUpdate {
  sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk";
  content: ContentBlock;
}

export type SessionUpdate = ContentChunkUpdate | ToolCallUpdate | PlanUpdate;
export interface SessionNotification { sessionId: string; update: SessionUpdate }

// ─── session/request_permission (agent → client, request) ───────────────────

export type PermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";
export interface PermissionOption { optionId: string; name: string; kind: PermissionOptionKind }
export interface RequestPermissionParams {
  sessionId: string;
  toolCall: ToolCallUpdate;
  options: PermissionOption[];
}
export type RequestPermissionOutcome =
  | { outcome: "cancelled" }
  | { outcome: "selected"; optionId: string };
export interface RequestPermissionResult { outcome: RequestPermissionOutcome }
