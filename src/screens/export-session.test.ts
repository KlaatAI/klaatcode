import { expect, test, describe } from "bun:test";
import {
  renderSessionMarkdown,
  defaultExportPath,
  resolveExportPath,
  fenceFor,
  type ExportMessage,
} from "./export-session";

describe("defaultExportPath / resolveExportPath", () => {
  test("default is cwd-relative klaatai-session-<id>.md", () => {
    expect(defaultExportPath("abc-123", "/tmp/proj")).toBe("/tmp/proj/klaatai-session-abc-123.md");
  });

  test("resolveExportPath uses default when arg missing or blank", () => {
    expect(resolveExportPath("s1", undefined, "/work")).toBe("/work/klaatai-session-s1.md");
    expect(resolveExportPath("s1", "  ", "/work")).toBe("/work/klaatai-session-s1.md");
  });

  test("resolveExportPath honors an explicit path", () => {
    expect(resolveExportPath("s1", "./out.md", "/work")).toBe("./out.md");
    expect(resolveExportPath("s1", "/tmp/session.md", "/work")).toBe("/tmp/session.md");
  });
});

describe("fenceFor", () => {
  test("uses at least triple backticks", () => {
    expect(fenceFor("hello")).toEqual({ open: "```", close: "```" });
  });

  test("lengthens fence past nested backticks in the body", () => {
    expect(fenceFor("code with ``` inside")).toEqual({ open: "````", close: "````" });
    expect(fenceFor("even ```` four")).toEqual({ open: "`````", close: "`````" });
  });

  test("keeps info string on the opening fence", () => {
    expect(fenceFor("-a\n+b", "diff")).toEqual({ open: "```diff", close: "```" });
  });
});

describe("renderSessionMarkdown", () => {
  const base = {
    sessionId: "20260720-demo",
    sessionCost: 0.0123,
    totalRequests: 2,
    exportedAt: new Date("2026-07-20T12:00:00Z"),
  };

  test("renders user and assistant turns without system messages", () => {
    const messages: ExportMessage[] = [
      { role: "system", content: "hidden rules" },
      { role: "user", content: "Fix the bug" },
      { role: "assistant", content: "I'll look into it.", tier: "code", elapsed: 1500 },
    ];
    const md = renderSessionMarkdown({ ...base, messages });
    expect(md).toContain("# KlaatAI Session — 20260720-demo");
    expect(md).toContain("*Exported: 2026-07-20T12:00:00*");
    expect(md).toContain("## You");
    expect(md).toContain("Fix the bug");
    expect(md).toContain("## Assistant");
    expect(md).toContain("tier: code");
    expect(md).toContain("I'll look into it.");
    expect(md).not.toContain("hidden rules");
    expect(md).toContain("*Session cost: $0.0123 | Requests: 2*");
  });

  test("collapses long tool output into a details block", () => {
    const long = Array.from({ length: 8 }, (_, i) => `line ${i}`).join("\n");
    const messages: ExportMessage[] = [
      { role: "tool", toolName: "read_file", toolSummary: "read src/a.ts", content: long },
    ];
    const md = renderSessionMarkdown({ ...base, messages });
    expect(md).toContain("### Tool: read src/a.ts");
    expect(md).toContain("<details>");
    expect(md).toContain("<summary>read src/a.ts · 8 lines</summary>");
    expect(md).toContain("line 0");
    expect(md).not.toMatch(/\{\s*"role"/); // no raw JSON dumps
  });

  test("short tool output stays as a simple fence", () => {
    const messages: ExportMessage[] = [
      { role: "tool", toolName: "run_command", toolSummary: "$ ls", content: "ok\n" },
    ];
    const md = renderSessionMarkdown({ ...base, messages });
    expect(md).toContain("### Tool: $ ls");
    expect(md).not.toContain("<details>");
    expect(md).toContain("```\nok\n```");
  });

  test("tool output containing markdown fences uses a longer outer fence", () => {
    const nested = [
      "example:",
      "```ts",
      "const x = 1;",
      "```",
      "done",
      "more",
      "lines",
      "here",
    ].join("\n");
    const messages: ExportMessage[] = [
      { role: "tool", toolName: "read_file", toolSummary: "read demo.md", content: nested },
    ];
    const md = renderSessionMarkdown({ ...base, messages });
    expect(md).toContain("````\n");
    expect(md).toContain("```ts");
    expect(md).toContain("const x = 1;");
    // Outer close is four ticks — nested triple fence must not terminate early.
    expect(md).toMatch(/````\n[\s\S]*```ts[\s\S]*```\n[\s\S]*````/);
  });

  test("tool diffs render as fenced diff blocks", () => {
    const messages: ExportMessage[] = [
      {
        role: "tool",
        toolName: "edit_file",
        toolSummary: "edit foo.ts",
        diffPath: "foo.ts",
        content: "edited",
        diff: [
          { sign: " ", text: "const x = 1;" },
          { sign: "-", text: "const y = 2;" },
          { sign: "+", text: "const y = 3;" },
        ],
      },
    ];
    const md = renderSessionMarkdown({ ...base, messages });
    expect(md).toContain("### Tool: edit foo.ts foo.ts (+1 −1)");
    expect(md).toContain("```diff");
    expect(md).toContain("-const y = 2;");
    expect(md).toContain("+const y = 3;");
  });

  test("assistant errors get an Error heading", () => {
    const messages: ExportMessage[] = [
      { role: "assistant", kind: "error", content: "boom" },
    ];
    const md = renderSessionMarkdown({ ...base, messages });
    expect(md).toContain("## Error");
    expect(md).toContain("boom");
  });
});
