import { expect, test, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ToolCall } from "../api/client.js";
import { checkPermission, type PermissionsFile } from "./index.js";
import {
  loadClaudeCompatRules,
  parseRule,
  ruleMatchesCall,
  checkImportedRules,
  summarizeCompatRules,
} from "./claude-settings.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function tc(name: string, args: Record<string, unknown>): ToolCall {
  return { id: "1", type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function withProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "klaatai-claude-compat-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

const EMPTY_PERMS: PermissionsFile = { trusted_tools: [], allowed_commands: [], denied_commands: [] };

// ─── Rule parsing ───────────────────────────────────────────────────────────

describe("parseRule", () => {
  test("bare tool name", () => {
    expect(parseRule("Bash")).toEqual({ raw: "Bash", tool: "Bash", arg: undefined });
  });
  test("tool with arg", () => {
    expect(parseRule("Bash(git *)")).toEqual({ raw: "Bash(git *)", tool: "Bash", arg: "git *" });
  });
  test("WebFetch domain rule", () => {
    expect(parseRule("WebFetch(domain:example.com)")?.arg).toBe("domain:example.com");
  });
  test("malformed rule returns null", () => {
    expect(parseRule("(nope")).toBeNull();
  });
});

// ─── loadClaudeCompatRules: no-file no-op ──────────────────────────────────

describe("loadClaudeCompatRules — no settings files", () => {
  test("returns null when neither file exists (no behavior change)", () => {
    const root = withProject({});
    expect(loadClaudeCompatRules(root)).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });
});

// ─── Fixture: allow / deny / ask honored ───────────────────────────────────

describe("fixture: allow/deny/ask each honored", () => {
  const root = withProject({
    ".claude/settings.json": JSON.stringify({
      permissions: {
        allow: ["Bash(git *)"],
        deny: ["Bash(rm *)"],
        ask: ["Bash(npm publish*)"],
      },
    }),
  });
  const rules = loadClaudeCompatRules(root);

  test("compiles allow/deny/ask into separate buckets", () => {
    expect(rules).not.toBeNull();
    expect(rules!.allow).toHaveLength(1);
    expect(rules!.deny).toHaveLength(1);
    expect(rules!.ask).toHaveLength(1);
  });

  test("allow rule permits a matching Bash call", () => {
    expect(checkImportedRules(tc("run_command", { command: "git status" }), rules!)).toBe("allow");
  });

  test("deny rule rejects a matching Bash call", () => {
    expect(checkImportedRules(tc("run_command", { command: "rm -rf build" }), rules!)).toBe("deny");
  });

  test("ask rule surfaces a prompt for a matching Bash call", () => {
    expect(checkImportedRules(tc("run_command", { command: "npm publish --tag next" }), rules!)).toBe("ask");
  });

  test("non-matching call falls through to null", () => {
    expect(checkImportedRules(tc("run_command", { command: "ls -la" }), rules!)).toBeNull();
  });

  test("checkPermission honors an imported allow when native tier has no opinion", () => {
    expect(checkPermission(tc("run_command", { command: "git log --oneline" }), EMPTY_PERMS, rules)).toBe("allow");
  });

  test("checkPermission honors an imported deny", () => {
    expect(checkPermission(tc("run_command", { command: "rm -rf node_modules" }), EMPTY_PERMS, rules)).toBe("deny");
  });
});

// ─── Glob patterns ──────────────────────────────────────────────────────────

describe("glob patterns", () => {
  const root = withProject({
    ".claude/settings.json": JSON.stringify({
      permissions: { allow: ["Edit(src/**)"], deny: ["Edit(src/secrets/*)"] },
    }),
  });
  const rules = loadClaudeCompatRules(root)!;

  test("** crosses directories for Edit rules", () => {
    expect(ruleMatchesCall(rules.allow[0]!, tc("edit_file", { path: "src/a/b/c.ts" }))).toBe(true);
  });

  test("single * stays within a path segment for deny rules", () => {
    expect(ruleMatchesCall(rules.deny[0]!, tc("edit_file", { path: "src/secrets/key.pem" }))).toBe(true);
    expect(ruleMatchesCall(rules.deny[0]!, tc("edit_file", { path: "src/secrets/nested/key.pem" }))).toBe(false);
  });

  test("Edit rules also match apply_patch by scanning patch file headers", () => {
    const patch = "*** Update File: src/app/index.ts\n@@\n-old\n+new\n";
    expect(ruleMatchesCall(rules.allow[0]!, tc("apply_patch", { patch }))).toBe(true);
  });

  test("Edit rules match multi_edit via its path field", () => {
    expect(ruleMatchesCall(rules.allow[0]!, tc("multi_edit", { path: "src/util.ts", edits: [] }))).toBe(true);
  });

  test("WebFetch domain rule matches subdomains", () => {
    const wf = parseRule("WebFetch(domain:example.com)")!;
    expect(ruleMatchesCall(wf, tc("web_fetch", { url: "https://docs.example.com/api" }))).toBe(true);
    expect(ruleMatchesCall(wf, tc("web_fetch", { url: "https://evil.com" }))).toBe(false);
  });
});

// ─── Precedence ─────────────────────────────────────────────────────────────

describe("precedence", () => {
  test("deny beats allow within the imported layer", () => {
    const root = withProject({
      ".claude/settings.json": JSON.stringify({
        permissions: { allow: ["Bash(git *)"], deny: ["Bash(git push*)"] },
      }),
    });
    const rules = loadClaudeCompatRules(root)!;
    expect(checkImportedRules(tc("run_command", { command: "git push origin main" }), rules)).toBe("deny");
  });

  test("native config always outranks imported rules", () => {
    const root = withProject({
      ".claude/settings.json": JSON.stringify({ permissions: { deny: ["Bash"] } }),
    });
    const rules = loadClaudeCompatRules(root)!;
    // Native tier 1: run_command isn't in SAFE_TOOLS, but a native trusted_tools
    // entry or an explicit native allow should still win over an imported deny.
    const perms: PermissionsFile = { trusted_tools: [], allowed_commands: ["git status"], denied_commands: [] };
    expect(checkPermission(tc("run_command", { command: "git status" }), perms, rules)).toBe("allow");
  });

  test("local settings win over global on a conflicting rule", () => {
    const root = withProject({
      ".claude/settings.json": JSON.stringify({ permissions: { deny: ["Bash(git *)"] } }),
      ".claude/settings.local.json": JSON.stringify({ permissions: { allow: ["Bash(git *)"] } }),
    });
    const rules = loadClaudeCompatRules(root)!;
    expect(rules.deny).toHaveLength(0);
    expect(rules.allow).toHaveLength(1);
    expect(checkImportedRules(tc("run_command", { command: "git status" }), rules)).toBe("allow");
  });
});

// ─── Unmappable-rule skip ───────────────────────────────────────────────────

describe("unmappable rules are logged and skipped, not applied", () => {
  test("unknown tool name is collected separately and never matches", () => {
    const root = withProject({
      ".claude/settings.json": JSON.stringify({
        permissions: { allow: ["NotebookEdit(*.ipynb)", "Bash(git *)"] },
      }),
    });
    const rules = loadClaudeCompatRules(root)!;
    expect(rules.allow).toHaveLength(1); // only the Bash rule compiled
    expect(rules.unmappable).toHaveLength(1);
    expect(rules.unmappable[0]!.tool).toBe("NotebookEdit");
  });

  test("summary reports unmappable count", () => {
    const root = withProject({
      ".claude/settings.json": JSON.stringify({
        permissions: { allow: ["NotebookEdit(*.ipynb)"] },
      }),
    });
    const rules = loadClaudeCompatRules(root);
    const summary = summarizeCompatRules(rules);
    expect(summary).toContain("1 unmappable rule");
  });
});

// ─── No .claude/settings.json: zero behavior change ────────────────────────

describe("no behavior change when no .claude/settings.json exists", () => {
  test("checkPermission behaves identically with null imported rules", () => {
    const root = withProject({});
    const rules = loadClaudeCompatRules(root);
    expect(rules).toBeNull();
    const withoutLayer = checkPermission(tc("edit_file", { path: "src/x.ts" }), EMPTY_PERMS);
    const withNullLayer = checkPermission(tc("edit_file", { path: "src/x.ts" }), EMPTY_PERMS, rules);
    expect(withoutLayer).toBe(withNullLayer);
    expect(withNullLayer).toBe("ask");
  });
});