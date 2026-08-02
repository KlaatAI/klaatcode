import { ConfigError } from "./types";

type Coercion = "string" | "number" | "boolean" | "list";

const ENV_MAP: Record<string, { path: [string] | [string, string]; coerce: Coercion }> = {
  KLAAT_SERVER_HOST: { path: ["server", "host"], coerce: "string" },
  KLAAT_SERVER_PORT: { path: ["server", "port"], coerce: "number" },
  KLAAT_LOG_LEVEL: { path: ["logging", "level"], coerce: "string" },
  KLAAT_LOG_PRETTY: { path: ["logging", "pretty"], coerce: "boolean" },
  KLAAT_MAX_CONNECTIONS: { path: ["limits", "maxConnections"], coerce: "number" },
  KLAAT_TIMEOUT_MS: { path: ["limits", "timeoutMs"], coerce: "number" },
  KLAAT_TAGS: { path: ["tags"], coerce: "list" },
};

export type PartialConfig = Record<string, unknown>;

export function applyEnvLayer(env: Record<string, string>): PartialConfig {
  const out: PartialConfig = {};
  for (const [name, raw] of Object.entries(env)) {
    const mapping = ENV_MAP[name];
    if (!mapping) continue;
    const value = coerce(name, raw, mapping.coerce);
    if (mapping.path.length === 1) {
      out[mapping.path[0]] = value;
    } else {
      const [sectionKey, nestedKey] = mapping.path;
      const section = (out[sectionKey] ?? {}) as Record<string, unknown>;
      section[nestedKey] = value;
      out[sectionKey] = section;
    }
  }
  return out;
}

function coerce(name: string, raw: string, kind: Coercion): unknown {
  switch (kind) {
    case "string":
      return raw;
    case "number": {
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new ConfigError(`invalid number for ${name}: ${raw}`);
      return value;
    }
    case "boolean": {
      if (raw === "true" || raw === "1") return true;
      if (raw === "false" || raw === "0") return false;
      throw new ConfigError(`invalid boolean for ${name}: ${raw}`);
    }
    case "list":
      return raw
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
  }
}
