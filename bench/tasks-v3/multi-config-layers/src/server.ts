// Small consumer of the config module: builds a listen description string.
import { loadConfig, LoadOptions } from "./config/index";

export function describeListenAddress(options: LoadOptions = {}): string {
  const config = loadConfig(options);
  return `${config.server.host}:${config.server.port} (log=${config.logging.level})`;
}
