import type { PartialConfig } from "./types";
import { ConfigError } from "./types";
import { KEY_SPECS } from "./schema";

/**
 * Config file layer (third precedence). The file is a JSON document whose
 * shape mirrors the config tree, e.g.:
 *
 *   { "server": { "port": 9090 }, "logging": { "level": "debug" } }
 *
 * Unknown sections/keys throw; type mismatches throw. Values are already
 * typed in JSON, so no string coercion happens here.
 */
export function parseConfigFile(contents: string | null | undefined): PartialConfig {
  if (contents === null || contents === undefined || contents.trim() === "") {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (e) {
    throw new ConfigError("file", `invalid JSON: ${(e as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError("file", "top level must be an object");
  }
  const out: PartialConfig = {};
  const doc = parsed as Record<string, unknown>;
  for (const [section, body] of Object.entries(doc)) {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new ConfigError("file", `section "${section}" must be an object`);
    }
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      const spec = KEY_SPECS.find((s) => s.section === section && s.key === key);
      if (!spec) {
        throw new ConfigError("file", `unknown key: ${section}.${key}`);
      }
      const expected = spec.kind === "enum" ? "string" : spec.kind;
      if (typeof value !== expected) {
        throw new ConfigError("file", `${section}.${key}: expected ${expected}, got ${typeof value}`);
      }
      if (spec.kind === "enum" && !spec.enumValues?.includes(value as string)) {
        throw new ConfigError(
          "file",
          `${section}.${key}: "${String(value)}" not in [${spec.enumValues?.join(", ")}]`,
        );
      }
      const target = out as Record<string, Record<string, unknown>>;
      if (target[section] === undefined) target[section] = {};
      target[section]![key] = value;
    }
  }
  return out;
}
