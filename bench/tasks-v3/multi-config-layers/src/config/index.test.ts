import { test, expect } from "bun:test";
import { loadConfig, ConfigError } from "./index";
import { DEFAULTS } from "./defaults";
import { applyFileLayer } from "./fileLayer";
import { applyEnvLayer } from "./envLayer";
import { describeListenAddress } from "../server";

// ---------------------------------------------------------------------------
// defaults layer
// ---------------------------------------------------------------------------

test("DEFAULTS carries the documented baseline", () => {
  expect(DEFAULTS.server).toEqual({ host: "127.0.0.1", port: 8080 });
  expect(DEFAULTS.logging).toEqual({ level: "info", pretty: false });
  expect(DEFAULTS.limits).toEqual({ maxConnections: 100, timeoutMs: 30000 });
  expect(DEFAULTS.tags).toEqual([]);
});

// ---------------------------------------------------------------------------
// file layer
// ---------------------------------------------------------------------------

test("applyFileLayer keeps only provided keys (partial, deep)", () => {
  expect(applyFileLayer({ server: { port: 3000 } })).toEqual({ server: { port: 3000 } });
});

test("applyFileLayer rejects unknown top-level keys", () => {
  expect(() => applyFileLayer({ serverr: { port: 1 } })).toThrow(ConfigError);
});

test("applyFileLayer rejects unknown nested keys", () => {
  expect(() => applyFileLayer({ server: { hostt: "x" } })).toThrow(ConfigError);
});

test("applyFileLayer rejects non-object input", () => {
  expect(() => applyFileLayer("port=1" as unknown)).toThrow(ConfigError);
  expect(() => applyFileLayer([1, 2] as unknown)).toThrow(ConfigError);
});

test("applyFileLayer normalizes logging.level case and validates it", () => {
  expect(applyFileLayer({ logging: { level: "WARN" } })).toEqual({ logging: { level: "warn" } });
  expect(() => applyFileLayer({ logging: { level: "loud" } })).toThrow(ConfigError);
});

test("applyFileLayer coerces numeric-string server.port to a number", () => {
  expect(applyFileLayer({ server: { port: "9443" } })).toEqual({ server: { port: 9443 } });
});

// ---------------------------------------------------------------------------
// env layer
// ---------------------------------------------------------------------------

test("applyEnvLayer maps KLAAT_* vars with number coercion", () => {
  expect(applyEnvLayer({ KLAAT_SERVER_PORT: "9090" })).toEqual({ server: { port: 9090 } });
  expect(applyEnvLayer({ KLAAT_MAX_CONNECTIONS: "50", KLAAT_TIMEOUT_MS: "1000" })).toEqual({
    limits: { maxConnections: 50, timeoutMs: 1000 },
  });
});

test("applyEnvLayer coerces booleans (true/1/false/0)", () => {
  expect(applyEnvLayer({ KLAAT_LOG_PRETTY: "1" })).toEqual({ logging: { pretty: true } });
  expect(applyEnvLayer({ KLAAT_LOG_PRETTY: "true" })).toEqual({ logging: { pretty: true } });
  expect(applyEnvLayer({ KLAAT_LOG_PRETTY: "0" })).toEqual({ logging: { pretty: false } });
  expect(applyEnvLayer({ KLAAT_LOG_PRETTY: "false" })).toEqual({ logging: { pretty: false } });
});

test("applyEnvLayer parses comma lists, trimming and dropping empties", () => {
  expect(applyEnvLayer({ KLAAT_TAGS: "a, b,,c " })).toEqual({ tags: ["a", "b", "c"] });
});

test("applyEnvLayer ignores unrelated environment variables", () => {
  expect(applyEnvLayer({ PATH: "/usr/bin", HOME: "/root" })).toEqual({});
});

// ---------------------------------------------------------------------------
// composed loadConfig: precedence env > file > defaults, deep merge
// ---------------------------------------------------------------------------

test("loadConfig with no inputs returns the defaults as a fresh object", () => {
  const config = loadConfig({});
  expect(config).toEqual(DEFAULTS);
  expect(config).not.toBe(DEFAULTS);
  expect(config.server).not.toBe(DEFAULTS.server);
});

test("file layer overrides defaults but deep-merges sections", () => {
  const config = loadConfig({ fileData: { server: { port: 3000 } } });
  expect(config.server.port).toBe(3000);
  expect(config.server.host).toBe("127.0.0.1");
  expect(config.logging.level).toBe("info");
});

test("env layer overrides defaults but deep-merges sections", () => {
  const config = loadConfig({ env: { KLAAT_SERVER_HOST: "0.0.0.0" } });
  expect(config.server.host).toBe("0.0.0.0");
  expect(config.server.port).toBe(8080);
});

test("env beats file for the same key", () => {
  const config = loadConfig({
    fileData: { server: { port: 3000 } },
    env: { KLAAT_SERVER_PORT: "4000" },
  });
  expect(config.server.port).toBe(4000);
});

test("env and file combine within one section when keys differ", () => {
  const config = loadConfig({
    fileData: { logging: { pretty: true } },
    env: { KLAAT_LOG_LEVEL: "debug" },
  });
  expect(config.logging).toEqual({ level: "debug", pretty: true });
});

test("arrays are replaced wholesale, env winning over file", () => {
  const config = loadConfig({
    fileData: { tags: ["x"] },
    env: { KLAAT_TAGS: "y,z" },
  });
  expect(config.tags).toEqual(["y", "z"]);
});

test("loadConfig propagates ConfigError for unknown file keys", () => {
  expect(() => loadConfig({ fileData: { database: { url: "x" } } })).toThrow(ConfigError);
});

test("loadConfig never mutates DEFAULTS", () => {
  loadConfig({ fileData: { server: { port: 1 } }, env: { KLAAT_TAGS: "mutant" } });
  expect(DEFAULTS.server.port).toBe(8080);
  expect(DEFAULTS.tags).toEqual([]);
});

test("describeListenAddress composes the loaded config", () => {
  const text = describeListenAddress({
    fileData: { server: { host: "10.0.0.5" } },
    env: { KLAAT_SERVER_PORT: "9001", KLAAT_LOG_LEVEL: "warn" },
  });
  expect(text).toBe("10.0.0.5:9001 (log=warn)");
});
