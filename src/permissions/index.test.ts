import { describe, expect, test } from "bun:test";
import {
  checkPermission,
  summarizeTool,
  truncateToolResult,
  SAFE_TOOLS,
  type PermissionsFile,
} from "./index";
import type { ToolCall } from "../api/client.js";

function tc(name: string, args: Record<string, unknown>): ToolCall {
  return {
    id: "call_test",
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

const emptyPerms: PermissionsFile = {
  trusted_tools: [],
  allowed_commands: [],
  denied_commands: [],
};

describe("summarizeTool", () => {
  test("read_file / write_file / edit_file", () => {
    expect(summarizeTool(tc("read_file", { path: "src/foo.ts" }))).toBe("read   src/foo.ts");
    expect(summarizeTool(tc("read_file", { path: "a.ts", offset: 10, limit: 5 }))).toBe("read   a.ts:10–14");
    expect(summarizeTool(tc("write_file", { path: "out.txt" }))).toBe("write  out.txt");
    expect(summarizeTool(tc("edit_file", { path: "x.ts" }))).toBe("edit   x.ts");
  });

  test("run_command truncates long commands", () => {
    expect(summarizeTool(tc("run_command", { command: "npm test" }))).toBe("$  npm test");
    const long = "x".repeat(80);
    const s = summarizeTool(tc("run_command", { command: long }));
    expect(s.startsWith("$  ")).toBe(true);
    expect(s.length).toBeLessThanOrEqual(3 + 60);
    expect(s.endsWith("…")).toBe(true);
  });

  test("apply_patch counts files", () => {
    const patch = "*** Add File: a.ts\n+1\n*** Update File: b.ts\n@@\n";
    expect(summarizeTool(tc("apply_patch", { patch }))).toBe("patch  2 files");
  });

  test("glob / grep / list_dir", () => {
    expect(summarizeTool(tc("glob", { pattern: "**/*.ts" }))).toBe("glob   **/*.ts");
    expect(summarizeTool(tc("grep", { pattern: "TODO", path: "src" }))).toBe('grep   "TODO" in src');
    expect(summarizeTool(tc("list_dir", { path: "src" }))).toBe("ls     src");
  });
});

describe("checkPermission pattern matching", () => {
  test("SAFE_TOOLS always allow", () => {
    for (const name of ["read_file", "glob", "grep", "todo_read"]) {
      expect(SAFE_TOOLS.has(name)).toBe(true);
      expect(checkPermission(tc(name, {}), emptyPerms)).toBe("allow");
    }
  });

  test("denied_commands match wins over allowed", () => {
    const perms: PermissionsFile = {
      trusted_tools: [],
      allowed_commands: ["rm *"],
      denied_commands: ["rm -rf /"],
    };
    expect(checkPermission(tc("run_command", { command: "rm -rf /" }), perms)).toBe("deny");
  });

  test("allowed_commands glob match vs non-match", () => {
    const perms: PermissionsFile = {
      trusted_tools: [],
      allowed_commands: ["git status", "git diff *"],
      denied_commands: [],
    };
    expect(checkPermission(tc("run_command", { command: "git status" }), perms)).toBe("allow");
    expect(checkPermission(tc("run_command", { command: "git diff HEAD" }), perms)).toBe("allow");
    expect(checkPermission(tc("run_command", { command: "npm install" }), perms)).toBe("ask");
  });

  test("trusted write tools allow; untrusted ask", () => {
    expect(checkPermission(tc("write_file", { path: "a" }), emptyPerms)).toBe("ask");
    expect(checkPermission(tc("write_file", { path: "a" }), {
      ...emptyPerms,
      trusted_tools: ["write_file"],
    })).toBe("allow");
  });
});

describe("truncateToolResult", () => {
  test("leaves short results alone", () => {
    expect(truncateToolResult("hello")).toBe("hello");
  });

  test("truncates oversized results with a note", () => {
    const big = "a".repeat(50_000);
    const out = truncateToolResult(big);
    expect(out.length).toBeLessThan(big.length);
    expect(out).toContain("truncated");
  });
});
