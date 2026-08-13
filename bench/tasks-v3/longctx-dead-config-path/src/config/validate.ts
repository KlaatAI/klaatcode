import type { AppConfig } from "./types";
import { ConfigError } from "./types";

/**
 * Semantic validation of a fully-resolved config. Structural/type checks
 * already happened in the per-source parsers; this checks value ranges
 * and cross-field rules.
 */
export function validateConfig(config: AppConfig): AppConfig {
  const { server, limits, logging } = config;
  if (!Number.isInteger(server.port) || server.port < 1 || server.port > 65_535) {
    throw new ConfigError("validate", `server.port out of range: ${server.port}`);
  }
  if (server.host.trim() === "") {
    throw new ConfigError("validate", "server.host must not be empty");
  }
  if (!Number.isInteger(limits.maxConnections) || limits.maxConnections < 1) {
    throw new ConfigError("validate", `limits.maxConnections must be >= 1: ${limits.maxConnections}`);
  }
  if (limits.maxConnections > 10_000) {
    throw new ConfigError("validate", `limits.maxConnections above hard cap: ${limits.maxConnections}`);
  }
  if (!Number.isInteger(limits.requestTimeoutMs) || limits.requestTimeoutMs < 100) {
    throw new ConfigError("validate", `limits.requestTimeoutMs must be >= 100: ${limits.requestTimeoutMs}`);
  }
  // JSON logs at debug level are allowed but text+debug at scale is a
  // known foot-gun; the doctor command warns, validation permits it.
  if (logging.level === "debug" && limits.maxConnections > 5_000) {
    throw new ConfigError("validate", "debug logging with >5000 connections is not supported");
  }
  return config;
}
