import { describe, expect, test } from "bun:test";
import { MCP_PRESETS, getMCPPreset } from "./presets.js";

describe("MCP presets", () => {
  test("every preset has a unique id and a runnable config", () => {
    const ids = MCP_PRESETS.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of MCP_PRESETS) {
      expect(preset.name.length).toBeGreaterThan(0);
      expect(preset.description.length).toBeGreaterThan(0);
      expect(preset.config.command || preset.config.url).toBeTruthy();
    }
  });

  test("getMCPPreset resolves case-insensitively", () => {
    expect(getMCPPreset("AgentMemory")?.id).toBe("agentmemory");
    expect(getMCPPreset("nope")).toBeUndefined();
  });

  test("agentmemory preset spawns the published MCP shim via npx", () => {
    const preset = getMCPPreset("agentmemory");
    expect(preset).toBeDefined();
    expect(preset!.config.command).toBe("npx");
    expect(preset!.config.args).toEqual(["-y", "@agentmemory/mcp"]);
    // Env is read from the shell when the server spawns, not baked in at
    // enable-time — same convention as the GITHUB_TOKEN / DATABASE_URL presets.
    expect(preset!.config.env).toBeUndefined();
    expect(preset!.envVars).toContain("AGENTMEMORY_URL");
  });
});
