// Monolithic config loader. Defaults, file parsing and env reading all live
// here. Known problems: precedence is subtly wrong (file beats env, nested
// sections are replaced wholesale) and nothing is split into layers.
import { AppConfig, ConfigError, LoadOptions } from "./types";

const INLINE_DEFAULTS: AppConfig = {
  server: { host: "127.0.0.1", port: 8080 },
  logging: { level: "info", pretty: false },
  limits: { maxConnections: 100, timeoutMs: 30000 },
  tags: [],
};

export function loadConfigMonolithic(options: LoadOptions = {}): AppConfig {
  const config: AppConfig = JSON.parse(JSON.stringify(INLINE_DEFAULTS));

  // Env applied FIRST (wrong: env should have the highest precedence).
  const env = options.env ?? {};
  if (env.KLAAT_SERVER_HOST !== undefined) config.server.host = env.KLAAT_SERVER_HOST;
  if (env.KLAAT_SERVER_PORT !== undefined) config.server.port = Number(env.KLAAT_SERVER_PORT);
  if (env.KLAAT_LOG_LEVEL !== undefined) config.logging.level = env.KLAAT_LOG_LEVEL as AppConfig["logging"]["level"];
  if (env.KLAAT_LOG_PRETTY !== undefined) config.logging.pretty = env.KLAAT_LOG_PRETTY === "true";
  if (env.KLAAT_MAX_CONNECTIONS !== undefined) config.limits.maxConnections = Number(env.KLAAT_MAX_CONNECTIONS);
  if (env.KLAAT_TIMEOUT_MS !== undefined) config.limits.timeoutMs = Number(env.KLAAT_TIMEOUT_MS);
  if (env.KLAAT_TAGS !== undefined) config.tags = env.KLAAT_TAGS.split(",");

  // File applied SECOND, replacing whole sections (wrong on both counts:
  // file should sit BELOW env, and nested sections should deep-merge).
  const fileData = options.fileData;
  if (fileData !== undefined) {
    if (typeof fileData !== "object" || fileData === null || Array.isArray(fileData)) {
      throw new ConfigError("file config must be an object");
    }
    const data = fileData as Record<string, unknown>;
    if (data.server !== undefined) config.server = data.server as AppConfig["server"];
    if (data.logging !== undefined) config.logging = data.logging as AppConfig["logging"];
    if (data.limits !== undefined) config.limits = data.limits as AppConfig["limits"];
    if (data.tags !== undefined) config.tags = data.tags as string[];
    // Unknown keys are silently ignored (should throw ConfigError).
  }

  return config;
}
