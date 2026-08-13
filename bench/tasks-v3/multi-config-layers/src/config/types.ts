export interface ServerConfig {
  host: string;
  port: number;
}

export interface LoggingConfig {
  level: "debug" | "info" | "warn" | "error";
  pretty: boolean;
}

export interface LimitsConfig {
  maxConnections: number;
  timeoutMs: number;
}

export interface AppConfig {
  server: ServerConfig;
  logging: LoggingConfig;
  limits: LimitsConfig;
  tags: string[];
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface LoadOptions {
  fileData?: unknown;
  env?: Record<string, string>;
}
