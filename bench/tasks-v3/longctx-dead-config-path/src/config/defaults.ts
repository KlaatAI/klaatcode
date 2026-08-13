import type { AppConfig } from "./types";

/**
 * Built-in defaults: the lowest-precedence layer. Every key has a value
 * here, so resolution always produces a complete AppConfig.
 */
export function builtinDefaults(): AppConfig {
  return {
    server: {
      port: 8080,
      host: "127.0.0.1",
    },
    logging: {
      level: "info",
      format: "text",
    },
    limits: {
      maxConnections: 100,
      requestTimeoutMs: 30_000,
    },
    features: {
      metrics: false,
      tracing: false,
    },
  };
}

/** Sanity guard used by tests and the doctor command. */
export function isCompleteConfig(candidate: unknown): candidate is AppConfig {
  if (typeof candidate !== "object" || candidate === null) return false;
  const c = candidate as Record<string, unknown>;
  const server = c.server as Record<string, unknown> | undefined;
  const logging = c.logging as Record<string, unknown> | undefined;
  const limits = c.limits as Record<string, unknown> | undefined;
  const features = c.features as Record<string, unknown> | undefined;
  return (
    typeof server?.port === "number" &&
    typeof server?.host === "string" &&
    typeof logging?.level === "string" &&
    typeof logging?.format === "string" &&
    typeof limits?.maxConnections === "number" &&
    typeof limits?.requestTimeoutMs === "number" &&
    typeof features?.metrics === "boolean" &&
    typeof features?.tracing === "boolean"
  );
}
