import { AppConfig } from "./types";

export const DEFAULTS: AppConfig = {
  server: { host: "127.0.0.1", port: 8080 },
  logging: { level: "info", pretty: false },
  limits: { maxConnections: 100, timeoutMs: 30000 },
  tags: [],
};
