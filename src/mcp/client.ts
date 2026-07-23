/**
 * KlaatAI — MCP (Model Context Protocol) client.
 *
 * Two transports:
 *   - stdio: JSON-RPC 2.0 over newline-delimited JSON to a spawned process
 *   - Streamable HTTP (MCP spec 2025-03-26): JSON-RPC POSTed to a remote URL;
 *     responses arrive as plain JSON or as an SSE stream. Session continuity
 *     via the Mcp-Session-Id header.
 * Each MCPServerClient manages one server; MCPManager owns them all.
 *
 * Config file: ~/.klaatai/mcp.json (user-level) or .klaatai/mcp.json (project-level)
 *
 * Example config:
 *   {
 *     "servers": {
 *       "filesystem": {
 *         "command": "npx",
 *         "args": ["-y", "@modelcontextprotocol/server-filesystem", "~/projects"]
 *       },
 *       "github": {
 *         "command": "npx",
 *         "args": ["-y", "@modelcontextprotocol/server-github"],
 *         "env": { "GITHUB_TOKEN": "ghp_..." }
 *       },
 *       "linear": {
 *         "url": "https://mcp.linear.app/mcp",
 *         "headers": { "Authorization": "Bearer lin_..." }
 *       }
 *     }
 *   }
 *
 * Tool naming convention: mcp__<serverName>__<toolName>
 * (double-underscore delimited so tool names with underscores still parse correctly)
 */

import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ToolDefinition } from "../api/client.js";
import { storedMcpToken, refreshMcpToken, authorizeMcpServer } from "./oauth.js";
import {
  loadImportedMcpServers,
  mergeNativeMcpConfig,
  type MCPLoadOptions,
} from "./import.js";

// ─── Config ───────────────────────────────────────────────────────────────────

export interface MCPServerConfig {
  /** Executable to spawn (stdio transport), e.g. "npx", "python". Omit for remote servers. */
  command?: string;
  /** Arguments passed to the command (stdio transport). */
  args?: string[];
  /** Extra environment variables merged into the server process env (stdio transport). */
  env?: Record<string, string>;
  /** Remote server URL (Streamable HTTP transport, e.g. "https://mcp.example.com/mcp"). */
  url?: string;
  /** Extra HTTP headers for remote servers (e.g. { "Authorization": "Bearer …" }). */
  headers?: Record<string, string>;
  /** Optional human-readable description shown in the sidebar. */
  description?: string;
}

/** MCP server config plus optional source label (for imported servers). */
export interface MCPServerEntry extends MCPServerConfig {
  /** Config file the server was loaded from, e.g. ".cursor/mcp.json". */
  source?: string;
}

export interface MCPConfig {
  servers: Record<string, MCPServerEntry>;
}

export type { MCPLoadOptions } from "./import.js";

/**
 * Load MCP config by merging external imports and KlaatCode native configs.
 * Precedence (highest wins): .klaatai/mcp.json > ~/.klaatai/mcp.json >
 * .mcp.json > .claude.json > .cursor/mcp.json.
 */
export function loadMCPConfig(projectRoot: string, opts?: MCPLoadOptions): MCPConfig {
  const home = opts?.homeDir ?? homedir();
  const loadOpts = {
    projectRoot,
    homeDir: home,
    importMcpConfigs: opts?.importMcpConfigs,
    onLog: opts?.onLog,
  };

  const merged: Record<string, MCPServerEntry> = loadImportedMcpServers(loadOpts);
  mergeNativeMcpConfig(merged, projectRoot, home, loadOpts.onLog);

  // Always inject process.cwd() as the allowed directory for the filesystem
  // MCP server, regardless of what path was saved in mcp.json. This ensures
  // Klaat Code always scopes the filesystem server to the current project
  // directory rather than wherever the config was first written (e.g. HOME).
  for (const cfg of Object.values(merged)) {
    const args = cfg.args ?? [];
    const fsIdx = args.findIndex((a: string) => a.includes("server-filesystem"));
    if (fsIdx !== -1) {
      cfg.args = [...args.slice(0, fsIdx + 1), process.cwd()];
    }
  }

  return { servers: merged };
}

// ─── JSON-RPC types ───────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface MCPToolSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  description?: string;
}

interface MCPTool {
  name: string;
  description?: string;
  inputSchema: MCPToolSchema;
}

export interface MCPCallResultPart {
  type: "text" | "image" | "resource";
  text?: string;
  data?: string;       // base64 for image
  mimeType?: string;
}

interface MCPCallResult {
  content: MCPCallResultPart[];
  isError?: boolean;
}

// ─── Status ───────────────────────────────────────────────────────────────────

export type MCPStatus = "idle" | "connecting" | "connected" | "error" | "disconnected";

// ─── Pending request tracker ──────────────────────────────────────────────────

interface PendingCall {
  resolve: (v: unknown) => void;
  reject:  (e: Error)   => void;
  timer:   ReturnType<typeof setTimeout>;
}

// ─── MCPServerClient ──────────────────────────────────────────────────────────

export class MCPServerClient {
  readonly name: string;
  /** Config file this server was loaded from (undefined for runtime /mcp add). */
  readonly source?: string;
  private _config:  MCPServerConfig;
  private _proc:    ChildProcess | null = null;
  private _buffer:  string = "";
  private _pending: Map<number, PendingCall> = new Map();
  private _nextId:  number = 1;
  private _onStatusChange?: () => void;

  /** Discovered tools (populated after connect()). */
  tools:         MCPTool[]  = [];
  status:        MCPStatus  = "idle";
  statusMessage: string     = "";

  constructor(name: string, config: MCPServerConfig, onStatusChange?: () => void, source?: string) {
    this.name             = name;
    this.source           = source;
    this._config          = config;
    this._onStatusChange  = onStatusChange;
  }

  /** Convert discovered MCP tools to OpenAI-compatible ToolDefinitions. */
  toToolDefinitions(): ToolDefinition[] {
    return this.tools.map(t => ({
      type: "function" as const,
      function: {
        name:        `mcp__${this.name}__${t.name}`,
        description: `[MCP:${this.name}] ${t.description ?? t.name}`,
        parameters:  (t.inputSchema as unknown as Record<string, unknown>) ?? { type: "object", properties: {} },
      },
    }));
  }

  /** True when this server uses the Streamable HTTP transport. */
  get isRemote(): boolean {
    return !!this._config.url;
  }

  /**
   * Connect: spawn the process (stdio) or handshake over HTTP (remote),
   * then discover tools. Non-blocking — call without await to connect in
   * the background.
   */
  async connect(): Promise<void> {
    this._setStatus("connecting", "");

    if (this._config.url) return this._connectHttp();
    if (!this._config.command) {
      this._setStatus("error", "config needs either \"command\" (stdio) or \"url\" (remote)");
      return;
    }

    try {
      this._proc = spawn(this._config.command, this._config.args ?? [], {
        stdio: ["pipe", "pipe", "pipe"],
        env:   { ...process.env, ...(this._config.env ?? {}) },
        cwd:   process.cwd(),
      });

      this._proc.on("error", (err: Error) => {
        this._setStatus("error", err.message);
        this._rejectAll(err);
      });

      this._proc.on("exit", (code: number | null) => {
        if (this.status === "connected") {
          this._setStatus("disconnected", `server exited (code ${code ?? "?"})`);
        }
        this._rejectAll(new Error("MCP server process exited"));
      });

      this._proc.stdout?.on("data", (chunk: Buffer) => {
        this._buffer += chunk.toString("utf-8");
        this._flush();
      });

      // MCP handshake
      await this._request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities:    { tools: {}, roots: { listChanged: false } },
        clientInfo:      { name: "klaatai-cli", version: "0.1.0" },
      });

      // Required acknowledgement notification (no response expected)
      this._notify("notifications/initialized", {});

      // Discover tools
      const result = await this._request("tools/list", {}) as { tools?: MCPTool[] };
      this.tools   = result.tools ?? [];

      this._setStatus("connected", `${this.tools.length} tool${this.tools.length !== 1 ? "s" : ""}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._setStatus("error", msg.slice(0, 80));
    }
  }

  /**
   * Call a tool by its short name (without the mcp__server__ prefix).
   * Returns a text result string.
   */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    if (this.status !== "connected" || (!this._proc && !this.isRemote)) {
      return `Error: MCP server "${this.name}" is not connected (status: ${this.status})`;
    }

    try {
      const result = await this._request("tools/call", {
        name:      toolName,
        arguments: args,
      }) as MCPCallResult;

      const texts = (result.content ?? [])
        .filter(c => c.type === "text")
        .map(c => c.text ?? "")
        .join("\n");

      if (result.isError) {
        return `MCP tool error (${this.name}/${toolName}): ${texts || "(no message)"}`;
      }
      return texts || "(tool returned no text output)";
    } catch (err) {
      return `Error calling MCP tool "${this.name}/${toolName}": ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  disconnect(): void {
    try { this._proc?.kill("SIGTERM"); } catch { /* ignore */ }
    this._proc = null;
    // Streamable HTTP: tell the server to drop the session (fire-and-forget).
    if (this._config.url && this._sessionId) {
      void fetch(this._config.url, {
        method: "DELETE",
        headers: { "Mcp-Session-Id": this._sessionId, ...(this._config.headers ?? {}) },
        signal: AbortSignal.timeout(5_000),
      }).catch(() => { /* best effort */ });
      this._sessionId = null;
    }
    this._rejectAll(new Error("disconnected"));
    this._setStatus("disconnected", "");
  }

  // ─── Streamable HTTP transport ──────────────────────────────────────

  private _sessionId: string | null = null;

  private async _connectHttp(): Promise<void> {
    try {
      const init = await this._httpRpc("initialize", {
        protocolVersion: "2025-03-26",
        capabilities:    { tools: {}, roots: { listChanged: false } },
        clientInfo:      { name: "klaatai-cli", version: "2.0.0" },
      }) as { protocolVersion?: string };
      void init;

      await this._httpNotify("notifications/initialized", {});

      const result = await this._httpRpc("tools/list", {}) as { tools?: MCPTool[] };
      this.tools   = result.tools ?? [];
      this._setStatus("connected", `${this.tools.length} tool${this.tools.length !== 1 ? "s" : ""} (http)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._setStatus("error", msg.slice(0, 80));
    }
  }

  /** OAuth bearer for this server (set by the 401 recovery path). */
  private _oauthToken: string | null = null;

  private _httpHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      ...(this._sessionId ? { "Mcp-Session-Id": this._sessionId } : {}),
      ...(this._oauthToken ? { "Authorization": `Bearer ${this._oauthToken}` } : {}),
      // Explicit config headers win — a user-supplied Authorization overrides OAuth.
      ...(this._config.headers ?? {}),
    };
  }

  /** POST a JSON-RPC request; handles both JSON and SSE response bodies. */
  private async _httpRpc(method: string, params: unknown, retryOn401 = true): Promise<unknown> {
    const id = this._nextId++;
    if (!this._oauthToken) this._oauthToken = storedMcpToken(this._config.url!) ;
    const res = await fetch(this._config.url!, {
      method: "POST",
      headers: this._httpHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params } satisfies JsonRpcRequest),
      signal: AbortSignal.timeout(60_000),
    });

    const sid = res.headers.get("mcp-session-id");
    if (sid) this._sessionId = sid;

    // OAuth 2.1 (MCP auth spec): 401 → silent refresh, else interactive
    // browser flow, then retry the request once.
    if (res.status === 401 && retryOn401 && !this._config.headers?.["Authorization"]) {
      this._setStatus("connecting", "authorizing (oauth)");
      this._oauthToken = await refreshMcpToken(this._config.url!)
        ?? await authorizeMcpServer(this._config.url!, (m) => this._setStatus("connecting", m.slice(0, 80)));
      if (this._oauthToken) return this._httpRpc(method, params, false);
      throw new Error(`MCP server "${this.name}" requires authorization (OAuth flow failed or was cancelled)`);
    }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from MCP server (${method})`);
    }

    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("text/event-stream")) {
      return this._readSSEResponse(res, id, method);
    }
    const json = await res.json() as JsonRpcResponse;
    if (json.error) throw new Error(`[${json.error.code}] ${json.error.message}`);
    return json.result;
  }

  /** POST a JSON-RPC notification (no id; server replies 202/204). */
  private async _httpNotify(method: string, params: unknown): Promise<void> {
    await fetch(this._config.url!, {
      method: "POST",
      headers: this._httpHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", method, params } satisfies JsonRpcRequest),
      signal: AbortSignal.timeout(15_000),
    });
  }

  /**
   * Read an SSE body until the JSON-RPC response matching `id` arrives.
   * Server-initiated requests/notifications on the stream are ignored.
   */
  private async _readSSEResponse(res: Response, id: number, method: string): Promise<unknown> {
    if (!res.body) throw new Error(`empty SSE body (${method})`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    // Parse one raw SSE event; returns the matched result or undefined.
    // Throws on a JSON-RPC error response for our id.
    const tryEvent = (rawEvent: string): { result: unknown } | undefined => {
      const data = rawEvent.split("\n")
        .filter(l => l.startsWith("data:"))
        .map(l => l.slice(5).trimStart())
        .join("\n");
      if (!data) return undefined;
      let msg: JsonRpcResponse;
      try { msg = JSON.parse(data) as JsonRpcResponse; } catch { return undefined; }
      if (msg.id !== id) return undefined; // server-initiated message — ignore
      if (msg.error) throw new Error(`[${msg.error.code}] ${msg.error.message}`);
      return { result: msg.result };
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (value) buf += decoder.decode(value, { stream: true });
        // Events are separated by a blank line…
        for (;;) {
          const sep = buf.indexOf("\n\n");
          if (sep === -1) break;
          const hit = tryEvent(buf.slice(0, sep));
          buf = buf.slice(sep + 2);
          if (hit) return hit.result;
        }
        if (done) {
          // …but the final event may end with stream close instead of a
          // blank line — parse whatever is left.
          buf += decoder.decode();
          const hit = buf.trim() ? tryEvent(buf) : undefined;
          if (hit) return hit.result;
          break;
        }
      }
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
    throw new Error(`SSE stream ended without a response (${method})`);
  }

  // ─── Private helpers ────────────────────────────────────────────────

  private _setStatus(s: MCPStatus, msg: string): void {
    this.status        = s;
    this.statusMessage = msg;
    this._onStatusChange?.();
  }

  private _flush(): void {
    const lines = this._buffer.split("\n");
    this._buffer = lines.pop() ?? "";
    for (const raw of lines) {
      const t = raw.trim();
      if (!t) continue;
      try {
        const msg = JSON.parse(t) as JsonRpcResponse;
        if (typeof msg.id !== "number") continue; // ignore notifications from server
        const p = this._pending.get(msg.id);
        if (!p) continue;
        this._pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) {
          p.reject(new Error(`[${msg.error.code}] ${msg.error.message}`));
        } else {
          p.resolve(msg.result);
        }
      } catch { /* skip malformed JSON line */ }
    }
  }

  private _request(method: string, params: unknown): Promise<unknown> {
    if (this.isRemote) return this._httpRpc(method, params);
    return new Promise<unknown>((resolve, reject) => {
      const id    = this._nextId++;
      const timer = setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`MCP request timed out: ${method}`));
        }
      }, 30_000);
      this._pending.set(id, { resolve, reject, timer });
      this._write({ jsonrpc: "2.0", id, method, params } satisfies JsonRpcRequest);
    });
  }

  private _notify(method: string, params: unknown): void {
    if (this.isRemote) { void this._httpNotify(method, params); return; }
    this._write({ jsonrpc: "2.0", method, params } satisfies JsonRpcRequest);
  }

  private _write(msg: unknown): void {
    try {
      this._proc?.stdin?.write(JSON.stringify(msg) + "\n");
    } catch { /* process may have died */ }
  }

  private _rejectAll(err: Error): void {
    for (const [id, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this._pending.delete(id);
    }
  }
}

// ─── MCPManager ───────────────────────────────────────────────────────────────

/**
 * Manages all configured MCP server connections and provides a unified
 * interface for tool discovery and routing.
 */
export class MCPManager {
  private _servers: Map<string, MCPServerClient> = new Map();
  private _onStatusChange?: () => void;

  constructor(onStatusChange?: () => void) {
    this._onStatusChange = onStatusChange;
  }

  /**
   * Create client instances for all servers and begin connecting
   * in the background (non-blocking). Status updates trigger onStatusChange.
   */
  connect(config: MCPConfig): void {
    for (const [name, serverCfg] of Object.entries(config.servers)) {
      const { source, ...cfg } = serverCfg;
      const client = new MCPServerClient(name, cfg, this._onStatusChange, source);
      this._servers.set(name, client);
      // Fire-and-forget: errors set client.status = "error"
      void client.connect();
    }
  }

  get servers(): MCPServerClient[] {
    return [...this._servers.values()];
  }

  get isEmpty(): boolean {
    return this._servers.size === 0;
  }

  /** All connected servers' tools as ToolDefinitions. */
  get toolDefinitions(): ToolDefinition[] {
    const out: ToolDefinition[] = [];
    for (const s of this._servers.values()) {
      if (s.status === "connected") {
        out.push(...s.toToolDefinitions());
      }
    }
    return out;
  }

  /** True if this name looks like an MCP tool (starts with mcp__). */
  isMCPTool(name: string): boolean {
    return name.startsWith("mcp__");
  }

  /**
   * Route a tool call to the appropriate MCP server.
   * Tool name format: `mcp__<serverName>__<toolName>`
   * Returns null if the name doesn't match the MCP pattern.
   */
  async callTool(fullName: string, args: Record<string, unknown>): Promise<string | null> {
    if (!this.isMCPTool(fullName)) return null;

    // "mcp" __ "serverName" __ "tool_name" (tool name may contain double underscores)
    const withoutPrefix = fullName.slice("mcp__".length);
    const sepIdx        = withoutPrefix.indexOf("__");
    if (sepIdx === -1) return `Error: malformed MCP tool name "${fullName}"`;

    const serverName = withoutPrefix.slice(0, sepIdx);
    const toolName   = withoutPrefix.slice(sepIdx + 2);
    const server     = this._servers.get(serverName);

    if (!server) {
      return `Error: no MCP server named "${serverName}" (configured: ${[...this._servers.keys()].join(", ") || "none"})`;
    }

    return server.callTool(toolName, args);
  }

  /**
   * Connect a single named server (used by /mcp enable at runtime).
   * If a server with that name already exists, it is disconnected first.
   */
  connectOne(name: string, config: MCPServerConfig): void {
    const existing = this._servers.get(name);
    if (existing) existing.disconnect();
    const client = new MCPServerClient(name, config, this._onStatusChange);
    this._servers.set(name, client);
    void client.connect();
  }

  /**
   * Disconnect and remove a single named server (used by /mcp disable).
   */
  disconnectOne(name: string): void {
    const srv = this._servers.get(name);
    if (srv) { srv.disconnect(); this._servers.delete(name); }
  }

  disconnectAll(): void {
    for (const s of this._servers.values()) s.disconnect();
    this._servers.clear();
  }
}
