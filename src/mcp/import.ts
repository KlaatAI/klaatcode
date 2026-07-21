/**
 * Import MCP server definitions from external tool configs
 * (.mcp.json, .claude.json, .cursor/mcp.json).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MCPServerConfig, MCPServerEntry } from "./client.js";

export interface MCPLoadOptions {
  projectRoot?: string;
  homeDir?: string;
  /** When false, skip external config imports. Default: true. */
  importMcpConfigs?: boolean;
  /** Receives lines like `mcp: imported "linear" from .cursor/mcp.json`. */
  onLog?: (msg: string) => void;
}

interface ExpandContext {
  projectRoot: string;
  homeDir: string;
  env: NodeJS.ProcessEnv;
}

const REMOTE_TYPES = new Set(["http", "sse", "streamable-http"]);

/** Expand ${VAR}, ${VAR:-default}, ${env:VAR}, ${workspaceFolder}, ${userHome}. */
export function expandMcpEnvRefs(value: string, ctx: ExpandContext): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, raw: string) => {
    const key = raw.trim();
    const defaultMatch = /^([^:]+):-(.*)$/.exec(key);
    if (defaultMatch) {
      const envVal = ctx.env[defaultMatch[1]!];
      return envVal !== undefined && envVal !== "" ? envVal : defaultMatch[2]!;
    }
    if (key === "workspaceFolder") return ctx.projectRoot;
    if (key === "userHome") return ctx.homeDir;
    if (key.startsWith("env:")) return ctx.env[key.slice(4)] ?? "";
    return ctx.env[key] ?? "";
  });
}

function expandStringRecord(
  record: Record<string, string> | undefined,
  ctx: ExpandContext,
): Record<string, string> | undefined {
  if (!record) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) {
    out[k] = expandMcpEnvRefs(v, ctx);
  }
  return out;
}

function expandStringArray(values: string[] | undefined, ctx: ExpandContext): string[] | undefined {
  if (!values) return undefined;
  return values.map(v => expandMcpEnvRefs(v, ctx));
}

/** Map an external mcpServers entry to KlaatCode's MCPServerConfig. */
export function mapExternalMcpServer(
  entry: Record<string, unknown>,
  ctx: ExpandContext,
): MCPServerConfig | null {
  const type = typeof entry["type"] === "string" ? entry["type"].toLowerCase() : "";
  const url = typeof entry["url"] === "string" ? expandMcpEnvRefs(entry["url"], ctx) : undefined;
  const isRemote = !!url || REMOTE_TYPES.has(type);

  if (isRemote) {
    if (!url) return null;
    const headers = expandStringRecord(
      entry["headers"] as Record<string, string> | undefined,
      ctx,
    );
    const description = typeof entry["description"] === "string" ? entry["description"] : undefined;
    return {
      url,
      ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
      ...(description ? { description } : {}),
    };
  }

  const command = typeof entry["command"] === "string"
    ? expandMcpEnvRefs(entry["command"], ctx)
    : undefined;
  if (!command) return null;

  const args = expandStringArray(entry["args"] as string[] | undefined, ctx);
  const env = expandStringRecord(entry["env"] as Record<string, string> | undefined, ctx);
  const description = typeof entry["description"] === "string" ? entry["description"] : undefined;

  return {
    command,
    ...(args?.length ? { args } : {}),
    ...(env && Object.keys(env).length > 0 ? { env } : {}),
    ...(description ? { description } : {}),
  };
}

/** Parse `mcpServers` from a JSON object (external tool format). */
export function parseExternalMcpFile(
  raw: unknown,
  ctx: ExpandContext,
): Record<string, MCPServerConfig> {
  if (!raw || typeof raw !== "object") return {};
  const mcpServers = (raw as { mcpServers?: unknown }).mcpServers;
  if (!mcpServers || typeof mcpServers !== "object" || Array.isArray(mcpServers)) return {};

  const out: Record<string, MCPServerConfig> = {};
  for (const [name, entry] of Object.entries(mcpServers)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const mapped = mapExternalMcpServer(entry as Record<string, unknown>, ctx);
    if (mapped) out[name] = mapped;
  }
  return out;
}

function readJsonFile(path: string): unknown | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as unknown;
  } catch {
    return null;
  }
}

function mergeImportedServers(
  merged: Record<string, MCPServerEntry>,
  servers: Record<string, MCPServerConfig>,
  sourceLabel: string,
  onLog?: (msg: string) => void,
): void {
  for (const [name, cfg] of Object.entries(servers)) {
    const existing = merged[name];
    if (existing) {
      onLog?.(`mcp: skipped "${name}" from ${existing.source ?? "config"} (overridden by ${sourceLabel})`);
    } else {
      onLog?.(`mcp: imported "${name}" from ${sourceLabel}`);
    }
    merged[name] = { ...cfg, source: sourceLabel };
  }
}

function mergeNativeServers(
  merged: Record<string, MCPServerEntry>,
  servers: Record<string, MCPServerConfig>,
  sourceLabel: string,
  onLog?: (msg: string) => void,
): void {
  for (const [name, cfg] of Object.entries(servers)) {
    const existing = merged[name];
    if (existing?.source && existing.source !== sourceLabel) {
      onLog?.(`mcp: skipped "${name}" from ${existing.source} (overridden by ${sourceLabel})`);
    }
    merged[name] = { ...cfg, source: sourceLabel };
  }
}

/**
 * Load external MCP configs in precedence order (lowest first).
 * Returns servers keyed by name with a `source` label on each entry.
 */
export function loadImportedMcpServers(opts: MCPLoadOptions & { projectRoot: string }): Record<string, MCPServerEntry> {
  if (opts.importMcpConfigs === false) return {};

  const home = opts.homeDir ?? homedir();
  const ctx: ExpandContext = {
    projectRoot: opts.projectRoot,
    homeDir: home,
    env: process.env,
  };
  const merged: Record<string, MCPServerEntry> = {};

  const importSources: Array<{ path: string; label: string }> = [
    { path: join(opts.projectRoot, ".cursor", "mcp.json"), label: ".cursor/mcp.json" },
    { path: join(opts.projectRoot, ".claude.json"), label: ".claude.json" },
    { path: join(opts.projectRoot, ".mcp.json"), label: ".mcp.json" },
  ];

  for (const { path, label } of importSources) {
    const raw = readJsonFile(path);
    if (!raw) continue;
    const servers = parseExternalMcpFile(raw, ctx);
    mergeImportedServers(merged, servers, label, opts.onLog);
  }

  return merged;
}

/** Merge native KlaatCode config paths over imported servers. */
export function mergeNativeMcpConfig(
  merged: Record<string, MCPServerEntry>,
  projectRoot: string,
  homeDir: string,
  onLog?: (msg: string) => void,
): void {
  const nativePaths: Array<{ path: string; label: string }> = [
    { path: join(homeDir, ".klaatai", "mcp.json"), label: "~/.klaatai/mcp.json" },
    { path: join(projectRoot, ".klaatai", "mcp.json"), label: ".klaatai/mcp.json" },
  ];

  for (const { path, label } of nativePaths) {
    const raw = readJsonFile(path);
    if (!raw || typeof raw !== "object") continue;
    const servers = (raw as { servers?: unknown }).servers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) continue;
    mergeNativeServers(
      merged,
      servers as Record<string, MCPServerConfig>,
      label,
      onLog,
    );
  }
}
