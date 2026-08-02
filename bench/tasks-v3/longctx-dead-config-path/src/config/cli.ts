import type { PartialConfig } from "./types";
import { ConfigError } from "./types";
import { assignValue, coerceValue, specByCliFlag } from "./schema";

/**
 * CLI argument layer (highest precedence). Accepts `--flag=value` and
 * `--flag value` forms; boolean flags may appear bare (`--features.metrics`).
 * Unknown flags throw so typos surface immediately.
 */
export function parseCliArgs(argv: string[]): PartialConfig {
  const out: PartialConfig = {};
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      throw new ConfigError("cli", `unexpected positional argument: "${arg}"`);
    }
    let flag: string;
    let raw: string | undefined;
    const eq = arg.indexOf("=");
    if (eq >= 0) {
      flag = arg.slice(0, eq);
      raw = arg.slice(eq + 1);
    } else {
      flag = arg;
      raw = undefined;
    }
    const spec = specByCliFlag(flag);
    if (!spec) {
      throw new ConfigError("cli", `unknown flag: ${flag}`);
    }
    if (raw === undefined) {
      if (spec.kind === "boolean") {
        raw = "true";
      } else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
          throw new ConfigError("cli", `flag ${flag} requires a value`);
        }
        raw = next;
        i += 1;
      }
    }
    assignValue(out, spec, coerceValue(spec, raw, "cli"));
    i += 1;
  }
  return out;
}
