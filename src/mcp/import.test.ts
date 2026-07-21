import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadMCPConfig } from "./client.js";
import {
  expandMcpEnvRefs,
  mapExternalMcpServer,
  parseExternalMcpFile,
} from "./import.js";

describe("expandMcpEnvRefs", () => {
  const ctx = {
    projectRoot: "/workspace/proj",
    homeDir: "/home/user",
    env: { API_KEY: "secret", EMPTY: "" },
  };

  test("expands ${VAR} and ${VAR:-default}", () => {
    expect(expandMcpEnvRefs("key=${API_KEY}", ctx)).toBe("key=secret");
    expect(expandMcpEnvRefs("key=${MISSING:-fallback}", ctx)).toBe("key=fallback");
    expect(expandMcpEnvRefs("key=${EMPTY:-fallback}", ctx)).toBe("key=fallback");
  });

  test("expands Cursor-style refs", () => {
    expect(expandMcpEnvRefs("${workspaceFolder}/server.py", ctx)).toBe("/workspace/proj/server.py");
    expect(expandMcpEnvRefs("${userHome}/.config", ctx)).toBe("/home/user/.config");
    expect(expandMcpEnvRefs("${env:API_KEY}", ctx)).toBe("secret");
  });
});

describe("parseExternalMcpFile", () => {
  const ctx = {
    projectRoot: "/workspace/proj",
    homeDir: "/home/user",
    env: { TOKEN: "tok" },
  };

  test("maps stdio Claude entry", () => {
    const servers = parseExternalMcpFile({
      mcpServers: {
        playwright: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@playwright/mcp@latest"],
        },
      },
    }, ctx);
    expect(servers["playwright"]).toEqual({
      command: "npx",
      args: ["-y", "@playwright/mcp@latest"],
    });
  });

  test("maps remote http entry with env expansion", () => {
    const servers = parseExternalMcpFile({
      mcpServers: {
        linear: {
          type: "http",
          url: "https://mcp.example.com",
          headers: { Authorization: "Bearer ${TOKEN}" },
        },
      },
    }, ctx);
    expect(servers["linear"]).toEqual({
      url: "https://mcp.example.com",
      headers: { Authorization: "Bearer tok" },
    });
  });

  test("maps Cursor remote entry without type", () => {
    const servers = parseExternalMcpFile({
      mcpServers: {
        remote: {
          url: "https://api.example.com/mcp",
          headers: { Authorization: "Bearer ${env:TOKEN}" },
        },
      },
    }, ctx);
    expect(servers["remote"]?.url).toBe("https://api.example.com/mcp");
  });
});

describe("loadMCPConfig imports", () => {
  let projectRoot = "";
  let homeDir = "";

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "klaat-mcp-project-"));
    homeDir = mkdtempSync(join(tmpdir(), "klaat-mcp-home-"));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  test("imports from .cursor/mcp.json", () => {
    mkdirSync(join(projectRoot, ".cursor"), { recursive: true });
    writeFileSync(join(projectRoot, ".cursor", "mcp.json"), JSON.stringify({
      mcpServers: {
        linear: { url: "https://mcp.linear.app/mcp" },
      },
    }));

    const logs: string[] = [];
    const cfg = loadMCPConfig(projectRoot, { homeDir, onLog: m => logs.push(m) });
    expect(cfg.servers["linear"]?.url).toBe("https://mcp.linear.app/mcp");
    expect(cfg.servers["linear"]?.source).toBe(".cursor/mcp.json");
    expect(logs).toContain('mcp: imported "linear" from .cursor/mcp.json');
  });

  test("merges imports with precedence: .mcp.json over .cursor/mcp.json", () => {
    mkdirSync(join(projectRoot, ".cursor"), { recursive: true });
    writeFileSync(join(projectRoot, ".cursor", "mcp.json"), JSON.stringify({
      mcpServers: {
        shared: { command: "cursor-cmd" },
        cursorOnly: { command: "cursor-only" },
      },
    }));
    writeFileSync(join(projectRoot, ".mcp.json"), JSON.stringify({
      mcpServers: {
        shared: { command: "mcp-cmd" },
        mcpOnly: { command: "mcp-only" },
      },
    }));

    const logs: string[] = [];
    const cfg = loadMCPConfig(projectRoot, { homeDir, onLog: m => logs.push(m) });
    expect(cfg.servers["shared"]?.command).toBe("mcp-cmd");
    expect(cfg.servers["cursorOnly"]?.command).toBe("cursor-only");
    expect(cfg.servers["mcpOnly"]?.command).toBe("mcp-only");
    expect(logs.some(l => l.includes('overridden by .mcp.json'))).toBe(true);
  });

  test("native KlaatCode config overrides imports", () => {
    writeFileSync(join(projectRoot, ".mcp.json"), JSON.stringify({
      mcpServers: { imported: { command: "imported-cmd" } },
    }));
    mkdirSync(join(projectRoot, ".klaatai"), { recursive: true });
    writeFileSync(join(projectRoot, ".klaatai", "mcp.json"), JSON.stringify({
      servers: { imported: { command: "native-cmd" } },
    }));

    const logs: string[] = [];
    const cfg = loadMCPConfig(projectRoot, { homeDir, onLog: m => logs.push(m) });
    expect(cfg.servers["imported"]?.command).toBe("native-cmd");
    expect(cfg.servers["imported"]?.source).toBe(".klaatai/mcp.json");
    expect(logs.some(l => l.includes('overridden by .klaatai/mcp.json'))).toBe(true);
  });

  test("importMcpConfigs: false skips external files", () => {
    writeFileSync(join(projectRoot, ".mcp.json"), JSON.stringify({
      mcpServers: { imported: { command: "imported-cmd" } },
    }));

    const cfg = loadMCPConfig(projectRoot, { homeDir, importMcpConfigs: false });
    expect(cfg.servers["imported"]).toBeUndefined();
  });

  test("parses .claude.json mcpServers", () => {
    writeFileSync(join(projectRoot, ".claude.json"), JSON.stringify({
      mcpServers: {
        gh: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
        },
      },
    }));

    const cfg = loadMCPConfig(projectRoot, { homeDir });
    expect(cfg.servers["gh"]?.command).toBe("npx");
    expect(cfg.servers["gh"]?.source).toBe(".claude.json");
  });
});

describe("mapExternalMcpServer", () => {
  const ctx = {
    projectRoot: "/proj",
    homeDir: "/home",
    env: {},
  };

  test("returns null when stdio entry has no command", () => {
    expect(mapExternalMcpServer({ type: "stdio" }, ctx)).toBeNull();
  });
});
