/**
 * KlaatAI — MCP preset server configurations.
 *
 * Presets are well-known MCP servers installable via npx.
 * Users can enable them with: /mcp enable <preset>
 * which writes the config to ~/.klaatai/mcp.json and connects immediately.
 *
 * Presets are intentionally conservative — they only run with npx so there's
 * no global install requirement. Env vars (like GITHUB_TOKEN) are documented
 * but not required at enable-time; they're read from the shell environment
 * when the server process actually spawns.
 */

import type { MCPServerConfig } from "./client.js";

export interface MCPPreset {
  /** Short identifier used in /mcp enable <id> */
  id:          string;
  /** Human-readable name */
  name:        string;
  /** One-line description */
  description: string;
  /** Environment variables the server reads (for docs/warnings) */
  envVars?:    string[];
  /** The server config to write into mcp.json */
  config:      MCPServerConfig;
}

export const MCP_PRESETS: MCPPreset[] = [
  {
    id:          "filesystem",
    name:        "Filesystem",
    description: "Read and write files in the current project directory",
    config: {
      command:     "npx",
      args:        ["-y", "@modelcontextprotocol/server-filesystem", process.cwd()],
      description: "Project filesystem access via MCP",
    },
  },
  {
    id:          "github",
    name:        "GitHub",
    description: "Browse repos, read files, search code, create/list issues and PRs",
    envVars:     ["GITHUB_TOKEN"],
    config: {
      command:     "npx",
      args:        ["-y", "@modelcontextprotocol/server-github"],
      description: "GitHub API via MCP — requires GITHUB_TOKEN env var",
    },
  },
  {
    id:          "git",
    name:        "Git",
    description: "Run git operations: commit, push, log, diff, branch management",
    config: {
      command:     "npx",
      args:        ["-y", "@modelcontextprotocol/server-git", "--repository", process.cwd()],
      description: "Git operations via MCP",
    },
  },
  {
    id:          "postgres",
    name:        "PostgreSQL",
    description: "Query and inspect a PostgreSQL database",
    envVars:     ["DATABASE_URL"],
    config: {
      command:     "npx",
      args:        ["-y", "@modelcontextprotocol/server-postgres", process.env.DATABASE_URL ?? ""],
      description: "PostgreSQL access via MCP — requires DATABASE_URL env var",
    },
  },
  {
    id:          "brave-search",
    name:        "Brave Search",
    description: "Web search via Brave Search API",
    envVars:     ["BRAVE_API_KEY"],
    config: {
      command:     "npx",
      args:        ["-y", "@modelcontextprotocol/server-brave-search"],
      description: "Web search via Brave API — requires BRAVE_API_KEY env var",
    },
  },
  {
    id:          "puppeteer",
    name:        "Puppeteer",
    description: "Control a headless browser — navigate pages, click, screenshot, extract content",
    config: {
      command:     "npx",
      args:        ["-y", "@modelcontextprotocol/server-puppeteer"],
      description: "Headless browser control via MCP",
    },
  },
  {
    id:          "sqlite",
    name:        "SQLite",
    description: "Query and manage a local SQLite database file",
    config: {
      command:     "npx",
      args:        ["-y", "@modelcontextprotocol/server-sqlite", "--db-path", "./db.sqlite"],
      description: "SQLite access via MCP",
    },
  },
  {
    id:          "slack",
    name:        "Slack",
    description: "Read channels, post messages, and search Slack history",
    envVars:     ["SLACK_BOT_TOKEN", "SLACK_TEAM_ID"],
    config: {
      command:     "npx",
      args:        ["-y", "@modelcontextprotocol/server-slack"],
      description: "Slack API via MCP — requires SLACK_BOT_TOKEN and SLACK_TEAM_ID env vars",
    },
  },
];

/** Look up a preset by id (case-insensitive). */
export function getMCPPreset(id: string): MCPPreset | undefined {
  return MCP_PRESETS.find(p => p.id.toLowerCase() === id.toLowerCase());
}
