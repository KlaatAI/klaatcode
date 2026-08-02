/** Fully-resolved application configuration. */
export interface AppConfig {
  server: {
    port: number;
    host: string;
  };
  logging: {
    level: "error" | "warn" | "info" | "debug";
    format: "text" | "json";
  };
  limits: {
    maxConnections: number;
    requestTimeoutMs: number;
  };
  features: {
    metrics: boolean;
    tracing: boolean;
  };
}

/**
 * A partial configuration contributed by one source layer. Nested objects
 * may be partially present; missing keys are transparent in the merge.
 */
export interface PartialConfig {
  server?: Partial<AppConfig["server"]>;
  logging?: Partial<AppConfig["logging"]>;
  limits?: Partial<AppConfig["limits"]>;
  features?: Partial<AppConfig["features"]>;
}

/**
 * Raw inputs handed to loadConfig. Everything is passed in explicitly —
 * no ambient process/env/fs access — so resolution is deterministic.
 */
export interface ConfigSources {
  /** argv-style CLI arguments, e.g. ["--server.port=9000"]. */
  cliArgs?: string[];
  /** Environment map, e.g. { APPD_SERVER_PORT: "9000" }. */
  env?: Record<string, string>;
  /** Contents of the JSON config file, or null when absent. */
  fileContents?: string | null;
  /**
   * Contents of a deprecated `.appdrc` ini file, or null when absent.
   * Consulted ONLY by the explicit export tool (see README): normal
   * resolution must ignore it entirely.
   */
  legacyContents?: string | null;
}

export type ConfigLayerName = "defaults" | "file" | "env" | "cli";

export class ConfigError extends Error {
  constructor(readonly source: string, message: string) {
    super(`[${source}] ${message}`);
    this.name = "ConfigError";
  }
}
