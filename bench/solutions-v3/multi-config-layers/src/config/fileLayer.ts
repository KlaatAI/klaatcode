import { ConfigError } from "./types";

const KNOWN_SECTIONS: Record<string, string[] | null> = {
  server: ["host", "port"],
  logging: ["level", "pretty"],
  limits: ["maxConnections", "timeoutMs"],
  tags: null, // scalar/array key, no nested keys
};

const LOG_LEVELS = new Set(["debug", "info", "warn", "error"]);

export type PartialConfig = Record<string, unknown>;

export function applyFileLayer(fileData: unknown): PartialConfig {
  if (typeof fileData !== "object" || fileData === null || Array.isArray(fileData)) {
    throw new ConfigError("file config must be a plain object");
  }
  const data = fileData as Record<string, unknown>;
  const out: PartialConfig = {};

  for (const [key, value] of Object.entries(data)) {
    if (!(key in KNOWN_SECTIONS)) {
      throw new ConfigError(`unknown config key: ${key}`);
    }
    const nestedKeys = KNOWN_SECTIONS[key];
    if (nestedKeys === null) {
      out[key] = value;
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ConfigError(`config section '${key}' must be an object`);
    }
    const section: Record<string, unknown> = {};
    for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      if (!nestedKeys.includes(nestedKey)) {
        throw new ConfigError(`unknown config key: ${key}.${nestedKey}`);
      }
      section[nestedKey] = normalizeValue(key, nestedKey, nestedValue);
    }
    out[key] = section;
  }
  return out;
}

function normalizeValue(section: string, key: string, value: unknown): unknown {
  if (section === "logging" && key === "level") {
    if (typeof value !== "string") throw new ConfigError("logging.level must be a string");
    const level = value.toLowerCase();
    if (!LOG_LEVELS.has(level)) throw new ConfigError(`invalid logging.level: ${value}`);
    return level;
  }
  if (section === "server" && key === "port") {
    if (typeof value === "string") {
      const port = Number(value);
      if (!Number.isFinite(port)) throw new ConfigError(`invalid server.port: ${value}`);
      return port;
    }
    return value;
  }
  return value;
}
