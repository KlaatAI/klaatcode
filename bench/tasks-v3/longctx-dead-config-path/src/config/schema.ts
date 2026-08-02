import type { PartialConfig } from "./types";
import { ConfigError } from "./types";

/**
 * Single registry describing every configurable key: where it lives in
 * the config tree and how each source spells and types it. All source
 * parsers (cli, env, file, legacy) are driven by this table.
 */

export type Section = "server" | "logging" | "limits" | "features";

export interface KeySpec {
  section: Section;
  key: string;
  /** Modern CLI flag, without the value part. */
  cliFlag: string;
  /** Modern environment variable name. */
  envVar: string;
  /** Key name used by the deprecated `.appdrc` ini format. */
  legacyKey: string;
  kind: "number" | "string" | "boolean" | "enum";
  enumValues?: readonly string[];
}

export const KEY_SPECS: readonly KeySpec[] = [
  {
    section: "server", key: "port",
    cliFlag: "--server.port", envVar: "APPD_SERVER_PORT",
    legacyKey: "server_port", kind: "number",
  },
  {
    section: "server", key: "host",
    cliFlag: "--server.host", envVar: "APPD_SERVER_HOST",
    legacyKey: "server_host", kind: "string",
  },
  {
    section: "logging", key: "level",
    cliFlag: "--logging.level", envVar: "APPD_LOGGING_LEVEL",
    legacyKey: "log_level", kind: "enum",
    enumValues: ["error", "warn", "info", "debug"],
  },
  {
    section: "logging", key: "format",
    cliFlag: "--logging.format", envVar: "APPD_LOGGING_FORMAT",
    legacyKey: "log_format", kind: "enum",
    enumValues: ["text", "json"],
  },
  {
    section: "limits", key: "maxConnections",
    cliFlag: "--limits.max-connections", envVar: "APPD_LIMITS_MAX_CONNECTIONS",
    legacyKey: "max_connections", kind: "number",
  },
  {
    section: "limits", key: "requestTimeoutMs",
    cliFlag: "--limits.request-timeout-ms", envVar: "APPD_LIMITS_REQUEST_TIMEOUT_MS",
    legacyKey: "request_timeout_ms", kind: "number",
  },
  {
    section: "features", key: "metrics",
    cliFlag: "--features.metrics", envVar: "APPD_FEATURES_METRICS",
    legacyKey: "enable_metrics", kind: "boolean",
  },
  {
    section: "features", key: "tracing",
    cliFlag: "--features.tracing", envVar: "APPD_FEATURES_TRACING",
    legacyKey: "enable_tracing", kind: "boolean",
  },
] as const;

export function specByCliFlag(flag: string): KeySpec | undefined {
  return KEY_SPECS.find((s) => s.cliFlag === flag);
}

export function specByEnvVar(name: string): KeySpec | undefined {
  return KEY_SPECS.find((s) => s.envVar === name);
}

export function specByLegacyKey(name: string): KeySpec | undefined {
  return KEY_SPECS.find((s) => s.legacyKey === name);
}

/** Coerce a raw string value to the spec's type, or throw ConfigError. */
export function coerceValue(spec: KeySpec, raw: string, source: string): number | string | boolean {
  switch (spec.kind) {
    case "number": {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        throw new ConfigError(source, `${spec.section}.${spec.key}: not a number: "${raw}"`);
      }
      return n;
    }
    case "boolean": {
      if (raw === "true" || raw === "1") return true;
      if (raw === "false" || raw === "0") return false;
      throw new ConfigError(source, `${spec.section}.${spec.key}: not a boolean: "${raw}"`);
    }
    case "enum": {
      if (!spec.enumValues?.includes(raw)) {
        throw new ConfigError(
          source,
          `${spec.section}.${spec.key}: "${raw}" not in [${spec.enumValues?.join(", ")}]`,
        );
      }
      return raw;
    }
    case "string":
      return raw;
  }
}

/** Write a coerced value into a PartialConfig at the spec's location. */
export function assignValue(target: PartialConfig, spec: KeySpec, value: number | string | boolean): void {
  const t = target as Record<string, Record<string, unknown>>;
  if (t[spec.section] === undefined) t[spec.section] = {};
  t[spec.section]![spec.key] = value;
}
