# appd configuration

Configuration for the `appd` daemon is resolved from layered sources.

## Resolution order (authoritative)

Highest precedence first:

1. **CLI arguments** — `--server.port=9000`, `--logging.level=debug`, …
2. **Environment variables** — `APPD_SERVER_PORT`, `APPD_LOGGING_LEVEL`, …
3. **Config file** — JSON document (usually `appd.json`)
4. **Built-in defaults** — `src/config/defaults.ts`

A value set in a higher layer always wins. A layer that does not mention a
key is transparent for that key. This four-layer order is the complete
resolution model: no other source may influence the resolved config.

## Deprecated: legacy settings (`.appdrc` ini format)

Versions before 2.x stored settings in an ini-style `.appdrc` file
("legacy settings"). The format is **deprecated** and retained only so
users can migrate:

- The ONLY supported consumer is the explicit migration/export tool
  (`src/config/export-legacy.ts`), which converts a `.appdrc` into a
  modern JSON config file for the user to review and adopt.
- Legacy settings **MUST NOT** participate in normal config resolution.
  `loadConfig()` must produce identical output whether or not legacy
  settings are present in its sources. They override nothing — not even
  built-in defaults.

## Key reference

| Path                  | CLI flag                  | Env var                    | Default   |
| --------------------- | ------------------------- | -------------------------- | --------- |
| server.port           | --server.port             | APPD_SERVER_PORT           | 8080      |
| server.host           | --server.host             | APPD_SERVER_HOST           | 127.0.0.1 |
| logging.level         | --logging.level           | APPD_LOGGING_LEVEL         | info      |
| logging.format        | --logging.format          | APPD_LOGGING_FORMAT        | text      |
| limits.maxConnections | --limits.max-connections  | APPD_LIMITS_MAX_CONNECTIONS| 100       |
| limits.requestTimeoutMs | --limits.request-timeout-ms | APPD_LIMITS_REQUEST_TIMEOUT_MS | 30000 |
| features.metrics      | --features.metrics        | APPD_FEATURES_METRICS      | false     |
| features.tracing      | --features.tracing        | APPD_FEATURES_TRACING      | false     |
