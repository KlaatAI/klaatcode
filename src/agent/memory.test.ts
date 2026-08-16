import { describe, test, expect } from "bun:test";
import {
  parseDistillation, buildDistillationMessages, flattenTranscriptTail,
} from "./memory.js";

describe("parseDistillation", () => {
  test("extracts both files from tagged output", () => {
    const r = parseDistillation(
      "<project_memory>\n## Commands\n- bun test\n</project_memory>\n" +
      "<user_memory>\n- prefers terse answers\n</user_memory>",
    );
    expect(r).not.toBeNull();
    expect(r!.project).toContain("bun test");
    expect(r!.user).toContain("terse");
  });

  test("malformed output (missing tag) returns null — old memory survives", () => {
    expect(parseDistillation("Here's what I learned: the user likes tests.")).toBeNull();
    expect(parseDistillation("<project_memory>only one tag</project_memory>")).toBeNull();
  });

  test("(empty) placeholder collapses to empty string", () => {
    const r = parseDistillation(
      "<project_memory>\n(empty)\n</project_memory><user_memory>\n(empty)\n</user_memory>",
    );
    expect(r!.project).toBe("");
    expect(r!.user).toBe("");
  });
});

describe("buildDistillationMessages", () => {
  test("carries existing memory, transcript, and modified files", () => {
    const msgs = buildDistillationMessages({
      existingProject: "- uses bun",
      existingUser: "- hindi ok",
      transcriptTail: "user: fix the bug\nassistant: done",
      modifiedFiles: ["src/a.ts", "src/b.ts"],
    });
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.role).toBe("system");
    const u = msgs[1]!.content;
    expect(u).toContain("- uses bun");
    expect(u).toContain("- hindi ok");
    expect(u).toContain("src/a.ts");
    expect(u).toContain("fix the bug");
  });

  test("empty memories are marked (empty) so the distiller knows it starts fresh", () => {
    const msgs = buildDistillationMessages({
      existingProject: "", existingUser: "", transcriptTail: "user: hi", modifiedFiles: [],
    });
    expect(msgs[1]!.content).toContain("(empty)");
    expect(msgs[1]!.content).toContain("No files were modified");
  });
});

describe("flattenTranscriptTail", () => {
  test("keeps user/assistant text turns, drops system and empty ones", () => {
    const out = flattenTranscriptTail([
      { role: "system", content: "seed" },
      { role: "user", content: "do the thing" },
      { role: "assistant", content: "" },
      { role: "assistant", content: "did it" },
      { role: "tool", content: "raw output" },
    ]);
    expect(out).toBe("user: do the thing\nassistant: did it");
  });

  test("clips long messages and caps total size", () => {
    const long = "x".repeat(5_000);
    const out = flattenTranscriptTail([{ role: "user", content: long }]);
    expect(out.length).toBeLessThan(700);
    expect(out).toContain("[…]");
  });

  test("non-string content (image parts) is skipped, not crashed on", () => {
    const out = flattenTranscriptTail([
      { role: "user", content: [{ type: "image" }] },
      { role: "user", content: "after the image" },
    ]);
    expect(out).toBe("user: after the image");
  });
});
