import { expect, test, describe } from "bun:test";
import {
  buildEditDiff,
  buildMultiEditDiff,
  buildWriteDiff,
  lineOf,
  diffStat,
} from "./diff-view";

// ─── buildEditDiff ────────────────────────────────────────────────────────────

describe("buildEditDiff", () => {
  test("trims common prefix and suffix, shows only changed line", () => {
    const lines = buildEditDiff("foo\nbar\nbaz", "foo\nBAR\nbaz");
    // "foo" is context before, "baz" is context after
    const signs = lines.map((l) => l.sign);
    expect(signs).toContain("-");
    expect(signs).toContain("+");
    // the unchanged "foo" prefix should appear as context
    expect(lines.some((l) => l.sign === " " && l.text === "foo")).toBe(true);
    // old line removed, new line added
    expect(lines.some((l) => l.sign === "-" && l.text === "bar")).toBe(true);
    expect(lines.some((l) => l.sign === "+" && l.text === "BAR")).toBe(true);
  });

  test("includes one line of surrounding context", () => {
    const lines = buildEditDiff("a\nb\nc\nd", "a\nb\nX\nd");
    const contextLines = lines.filter((l) => l.sign === " ");
    // "b" is context before, "d" is context after
    expect(contextLines.some((l) => l.text === "b")).toBe(true);
    expect(contextLines.some((l) => l.text === "d")).toBe(true);
    // "a" is outside the ctx=1 window and should NOT appear
    expect(contextLines.some((l) => l.text === "a")).toBe(false);
  });

  test("caps output at MAX_LINES (24) and appends overflow marker", () => {
    // produce a large change: 30 removed + 30 added lines
    const oldStr = Array.from({ length: 30 }, (_, i) => `old${i}`).join("\n");
    const newStr = Array.from({ length: 30 }, (_, i) => `new${i}`).join("\n");
    const lines = buildEditDiff(oldStr, newStr);
    // cap() keeps MAX_LINES then adds one overflow line = 25 total
    expect(lines.length).toBe(25);
    expect(lines[24]!.text).toMatch(/more line/);
  });

  test("returns empty array when old and new are identical", () => {
    const lines = buildEditDiff("same\ntext", "same\ntext");
    // no removed or added lines
    expect(lines.filter((l) => l.sign !== " ").length).toBe(0);
  });

  test("handles empty strings on both sides", () => {
    expect(() => buildEditDiff("", "")).not.toThrow();
  });

  test("assigns gutter line numbers when startLine is provided", () => {
    const lines = buildEditDiff("a\nb", "a\nB", 10);
    const numbered = lines.filter((l) => l.ln !== undefined);
    expect(numbered.length).toBeGreaterThan(0);
    // first line "a" is at startLine (10)
    expect(numbered[0]!.ln).toBe(10);
  });

  test("omits line numbers when startLine is not provided", () => {
    const lines = buildEditDiff("a\nb", "a\nB");
    expect(lines.every((l) => l.ln === undefined)).toBe(true);
  });
});

// ─── buildMultiEditDiff ───────────────────────────────────────────────────────

describe("buildMultiEditDiff", () => {
  test("separates hunks with a blank context line", () => {
    const lines = buildMultiEditDiff([
      { old_string: "a", new_string: "A" },
      { old_string: "b", new_string: "B" },
    ]);
    // there should be a blank separator between the two hunks
    expect(lines.some((l) => l.sign === " " && l.text === "")).toBe(true);
  });

  test("caps combined output at MAX_LINES", () => {
    const big = Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n");
    const lines = buildMultiEditDiff([
      { old_string: big, new_string: big + "\nextra" },
      { old_string: big, new_string: big + "\nextra2" },
    ]);
    expect(lines.length).toBeLessThanOrEqual(25); // 24 kept + 1 overflow marker
  });
});

// ─── buildWriteDiff ───────────────────────────────────────────────────────────

describe("buildWriteDiff", () => {
  test("marks every line as added (+)", () => {
    const lines = buildWriteDiff("foo\nbar\nbaz");
    expect(lines.every((l) => l.sign === "+")).toBe(true);
  });

  test("numbers lines starting from 1", () => {
    const lines = buildWriteDiff("x\ny\nz");
    expect(lines[0]!.ln).toBe(1);
    expect(lines[1]!.ln).toBe(2);
    expect(lines[2]!.ln).toBe(3);
  });

  test("handles empty file (single empty line)", () => {
    const lines = buildWriteDiff("");
    expect(lines.length).toBe(1);
    expect(lines[0]!.sign).toBe("+");
    expect(lines[0]!.ln).toBe(1);
  });

  test("caps at MAX_LINES for large files", () => {
    const content = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
    const lines = buildWriteDiff(content);
    expect(lines.length).toBe(25); // 24 + overflow marker
  });
});

// ─── lineOf ───────────────────────────────────────────────────────────────────

describe("lineOf", () => {
  const haystack = "alpha\nbeta\ngamma\ndelta";

  test("returns 1-based line number for exact match", () => {
    // "beta\ngamma" starts on line 2
    expect(lineOf(haystack, "beta\ngamma")).toBe(2);
  });

  test("returns line number for single-line exact match", () => {
    expect(lineOf(haystack, "gamma")).toBe(3);
  });

  test("falls back to first-line match when full needle not found", () => {
    // needle whose first line exists but rest doesn't
    expect(lineOf(haystack, "beta\nNOT_THERE")).toBe(2);
  });

  test("returns undefined when neither full needle nor first line is found", () => {
    expect(lineOf(haystack, "totally missing")).toBeUndefined();
  });

  test("handles match at first line (line 1)", () => {
    expect(lineOf(haystack, "alpha")).toBe(1);
  });

  test("handles empty haystack", () => {
    expect(lineOf("", "anything")).toBeUndefined();
  });
});

// ─── diffStat ────────────────────────────────────────────────────────────────

describe("diffStat", () => {
  test("counts additions and deletions correctly", () => {
    const lines = buildEditDiff("a\nb\nc", "a\nB\nC");
    const { add, del } = diffStat(lines);
    expect(add).toBe(2); // B and C added
    expect(del).toBe(2); // b and c removed
  });

  test("returns zero counts for no changes", () => {
    const lines = buildEditDiff("same", "same");
    expect(diffStat(lines)).toEqual({ add: 0, del: 0 });
  });

  test("counts only additions for a write diff", () => {
    const lines = buildWriteDiff("x\ny");
    const { add, del } = diffStat(lines);
    expect(add).toBe(2);
    expect(del).toBe(0);
  });

  test("handles empty input array", () => {
    expect(diffStat([])).toEqual({ add: 0, del: 0 });
  });
});
