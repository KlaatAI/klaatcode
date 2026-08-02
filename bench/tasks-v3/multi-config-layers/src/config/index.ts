// Public entry point for configuration loading.
//
// TODO(config-split): the loader is still the monolith in ./monolith.ts.
// It should be composed from three layer modules:
//   ./defaults  — exports DEFAULTS (the baseline AppConfig)
//   ./fileLayer — validates/normalizes parsed file data (unknown keys throw)
//   ./envLayer  — reads KLAAT_* vars with type coercion
// merged with precedence env > file > defaults (deep merge per section).
import { loadConfigMonolithic } from "./monolith";
import { AppConfig, LoadOptions } from "./types";

export { ConfigError } from "./types";
export type { AppConfig, LoadOptions } from "./types";

export function loadConfig(options: LoadOptions = {}): AppConfig {
  return loadConfigMonolithic(options);
}
