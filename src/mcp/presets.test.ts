import { describe, expect, test } from "bun:test";
import { MCP_PRESETS, getMCPPreset } from "./presets";

describe("MCP presets", () => {
  test("slack preset is registered", () => {
    const slack = getMCPPreset("slack");
    expect(slack).toBeDefined();
    expect(slack!.name).toBe("Slack");
    expect(slack!.envVars).toContain("SLACK_BOT_TOKEN");
    expect(slack!.envVars).toContain("SLACK_TEAM_ID");
    expect(slack!.config.command).toBe("npx");
    expect(slack!.config.args).toEqual(["-y", "@modelcontextprotocol/server-slack"]);
  });

  test("preset lookup is case-insensitive", () => {
    expect(getMCPPreset("Slack")?.id).toBe("slack");
  });

  test("ids are unique", () => {
    const ids = MCP_PRESETS.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
