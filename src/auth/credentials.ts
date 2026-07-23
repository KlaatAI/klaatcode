/**
 * Credential and config storage in ~/.klaatai/
 *
 * credentials.json — API key / JWT tokens
 * config.json      — user preferences (base URL, theme, routing mode)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import chalk from "chalk";

const KLAATAI_DIR = join(homedir(), ".klaatai");
const CREDENTIALS_FILE = join(KLAATAI_DIR, "credentials.json");
const CONFIG_FILE = join(KLAATAI_DIR, "config.json");

export interface Credentials {
  /** @deprecated Legacy kl- API key. No longer read or written — auth is JWT-only. */
  apiKey?: string;
  accessToken?: string;        // Supabase JWT (browser login) — the only auth path
  refreshToken?: string;
  expiresAt?: number;          // epoch seconds
  userId?: string;
  email?: string;
  plan?: string;
}

export interface Config {
  baseUrl: string;             // KlaatAI API base URL
  routingDisplay: "minimal" | "full" | "off";
  theme: string;               // Theme name from THEME_NAMES (for example dark, light, tokyo-night)
  vimMode: boolean;            // Vim-style key bindings in the input field
  /**
   * Disable TLS certificate verification (corporate MITM proxies whose root
   * CA isn't in the bundled store). Prefer NODE_EXTRA_CA_CERTS=<corp-ca.pem>
   * when possible — this switch turns off verification entirely.
   */
  insecureTls?: boolean;
  /** Write sandbox: "project" (default, writes confined to cwd) or "off". */
  sandbox?: "project" | "off";
  /** Extra directories the agent may write to (absolute or ~-prefixed). */
  sandboxAllow?: string[];
  /** Post-edit diagnostics feedback loop: "on" (default) or "off". */
  diagnostics?: "on" | "off";
  /** Per-extension diagnostics command override, e.g. {".ts":"tsc --noEmit"}; {file} = changed file. */
  diagnosticsCommands?: Record<string, string>;
  /** Third-party OpenAI-compatible models, selectable via /model (added with /model add). */
  customModels?: CustomModelConfig[];
  /**
   * Tier-aware toolset dialects: "auto" (default) trims the tool schema on
   * cheap tiers (fast = core subset, pinned nano = no tools); "off" always
   * sends the full set.
   */
  toolDialects?: "auto" | "off";
  /** Tool-output noise filter (progress bars, passing-test spam, dupes): "on" (default) or "off". */
  outputFilter?: "on" | "off";
  /** Attention-ordered old-context arrangement ("lost in the middle"): "on" (default) or "off". */
  attentionOrder?: "on" | "off";
  /**
   * Burn-rate guard: pause the agent loop and ask when estimated session cost
   * crosses this many USD (0/undefined = off). Headless `run` has --max-cost.
   */
  maxSessionCost?: number;
  /** Per-phase soft token budgets (9.5): "on" (default) or "off". */
  phaseBudgets?: "on" | "off";
  /** Cross-tool compatibility toggles. */
  compat?: {
    /** Discover skills from ~/.claude/skills and .claude/skills (default: true). */
    importClaudeSkills?: boolean;
    /** Import MCP servers from .mcp.json / .claude.json / .cursor/mcp.json (default: true). */
    importMcpConfigs?: boolean;
  };
}

export interface CustomModelConfig {
  /** Display name used to select it: /model <name>. */
  name: string;
  /** API base, e.g. https://api.openai.com or https://api.openai.com/v1 (both work). */
  baseUrl: string;
  /** Model id sent in the request body, e.g. gpt-4o or claude-sonnet-5. */
  model: string;
  /** Literal API key. Prefer apiKeyEnv — config.json is plaintext. */
  apiKey?: string;
  /** Name of an environment variable holding the API key (preferred). */
  apiKeyEnv?: string;
}

/** Resolve a custom model's API key (env var wins over literal). */
export function resolveCustomModelKey(m: CustomModelConfig): string | null {
  if (m.apiKeyEnv) return process.env[m.apiKeyEnv] ?? null;
  return m.apiKey ?? null;
}

const DEFAULT_CONFIG: Config = {
  baseUrl: "https://api.klaatai.com",
  routingDisplay: "minimal",
  theme: "dark",
  vimMode: false,
};

function ensureDir(): void {
  if (!existsSync(KLAATAI_DIR)) {
    mkdirSync(KLAATAI_DIR, { recursive: true, mode: 0o700 });
  }
}

export function loadCredentials(): Credentials {
  try {
    if (!existsSync(CREDENTIALS_FILE)) return {};
    return JSON.parse(readFileSync(CREDENTIALS_FILE, "utf-8"));
  } catch {
    return {};
  }
}

export function saveCredentials(creds: Credentials): void {
  ensureDir();
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), {
    mode: 0o600, // owner read/write only
  });
}

export function clearCredentials(): void {
  if (existsSync(CREDENTIALS_FILE)) {
    writeFileSync(CREDENTIALS_FILE, "{}", { mode: 0o600 });
  }
}

export function loadConfig(): Config {
  try {
    if (!existsSync(CONFIG_FILE)) return { ...DEFAULT_CONFIG };
    const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    return { ...DEFAULT_CONFIG, ...raw };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      chalk.yellow(
        `⚠ Failed to parse ${CONFIG_FILE}: ${message}. Falling back to default config.`,
      ),
    );
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: Partial<Config>): void {
  ensureDir();
  const current = loadConfig();
  writeFileSync(CONFIG_FILE, JSON.stringify({ ...current, ...config }, null, 2));
}

/** Get the active auth token — env override → stored subscription JWT. */
export function getAuthToken(): string | null {
  const env = process.env["KLAATAI_API_KEY"];
  if (env) return env;
  const creds = loadCredentials();
  if (creds.accessToken) return creds.accessToken;
  return null;
}

/** Check if the user has any stored credentials. */
export function isAuthenticated(): boolean {
  return getAuthToken() !== null;
}
