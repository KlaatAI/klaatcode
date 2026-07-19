import { expect, test, describe } from "bun:test";
import {
  buildEditDiff,
  buildMultiEditDiff,
  buildWriteDiff,
  buildPatchDiff,
  lineOf,
  diffStat,
} from "./diff-view";
import type { PatchOp } from "../tools/apply-patch";

describe("buildEditDiff", () => {
  test("trims common prefix and suffix, shows only changed line", () => {
    const lines = buildEditDiff("foo\nbar\nbaz", "foo\nBAR\nbaz");
    expect(lines.some((l) => l.sign === "-" && l.text === "bar")).toBe(true);
    expect(lines.some((l) => l.sign === "+" && l.text === "BAR")).toBe(true);
    expect(lines.some((l) => l.sign === " " && l.text === "foo")).toBe(true);
    expect(lines.some((l) => l.sign === " " && l.text === "baz")).toBe(true);
  });
  test("includes exactly one line of surrounding context (ctx=1)", () => {
    const lines = buildEditDiff("a\nb\nc\nd", "a\nb\nX\nd");
    const ctx = lines.filter((l) => l.sign === " ");
    expect(ctx.some((l) => l.text === "b")).toBe(true);
    expect(ctx.some((l) => l.text === "d")).toBe(true);
    expect(ctx.some((l) => l.text === "a")).toBe(false);
  });
  test("caps output at MAX_LINES (24) and appends overflow marker", () => {
    const oldStr = Array.from({ length: 30 }, (_, i) => `old${i}`).join("\n");
    const newStr = Array.from({ length: 30 }, (_, i) => `new${i}`).join("\n");
    const lines = buildEditDiff(oldStr, newStr);
    expect(lines.length).toBe(25);
    expect(lines[24]!.sign).toBe(" ");
    expect(lines[24]!.text).toMatch(/\d+ more line/);
  });
  test("no-change input produces no +/- lines", () => {
    const lines = buildEditDiff("same\ntext", "same\ntext");
    expect(lines.every((l) => l.sign === " ")).toBe(true);
  });
  test("handles empty strings on both sides without throwing", () => {
    expect(() => buildEditDiff("", "")).not.toThrow();
    expect(buildEditDiff("", "").every((l) => l.sign === " ")).toBe(true);
  });
  test("assigns gutter line numbers when startLine is provided", () => {
    const lines = buildEditDiff("a\nb", "a\nB", 10);
    const numbered = lines.filter((l) => l.ln !== undefined);
    expect(numbered.length).toBeGreaterThan(0);
    expect(numbered[0]!.ln).toBe(10);
  });
  test("omits line numbers when startLine is not provided", () => {
    expect(buildEditDiff("a\nb", "a\nB").every((l) => l.ln === undefined)).toBe(true);
  });
});

describe("buildMultiEditDiff", () => {
  test("separates hunks with a blank context line between them", () => {
    const lines = buildMultiEditDiff([
      { old_string: "a", new_string: "A" },
      { old_string: "b", new_string: "B" },
    ]);
    const sepIdx = lines.findIndex((l) => l.sign === " " && l.text === "");
    expect(sepIdx).toBeGreaterThan(0);
    const before = lines.slice(0, sepIdx);
    expect(before.some((l) => l.sign === "-" && l.text === "a")).toBe(true);
    expect(before.some((l) => l.sign === "+" && l.text === "A")).toBe(true);
    const after = lines.slice(sepIdx + 1);
    expect(after.some((l) => l.sign === "-" && l.text === "b")).toBe(true);
    expect(after.some((l) => l.sign === "+" && l.text === "B")).toBe(true);
  });
  test("caps combined output at exactly MAX_LINES + overflow marker", () => {
    const oldStr = Array.from({ length: 20 }, (_, i) => `old${i}`).join("\n");
    const newStr = Array.from({ length: 20 }, (_, i) => `new${i}`).join("\n");
    const lines = buildMultiEditDiff([
      { old_string: oldStr, new_string: newStr },
      { old_string: oldStr, new_string: newStr },
    ]);
    expect(lines.length).toBe(25);
    expect(lines[24]!.text).toMatch(/\d+ more line/);
  });
});

describe("buildWriteDiff", () => {
  test("marks every line as added (+)", () => {
    expect(buildWriteDiff("foo\nbar\nbaz").every((l) => l.sign === "+")).toBe(true);
  });
  test("numbers lines starting from 1", () => {
    const lines = buildWriteDiff("x\ny\nz");
    expect(lines[0]!.ln).toBe(1);
    expect(lines[1]!.ln).toBe(2);
    expect(lines[2]!.ln).toBe(3);
  });
  test("handles empty file (single empty-string line, numbered 1)", () => {
    const lines = buildWriteDiff("");
    expect(lines.length).toBe(1);
    expect(lines[0]!.sign).toBe("+");
    expect(lines[0]!.ln).toBe(1);
    expect(lines[0]!.text).toBe("");
  });
  test("caps at exactly MAX_LINES + overflow marker for large files", () => {
    const content = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
    const lines = buildWriteDiff(content);
    expect(lines.length).toBe(25);
    expect(lines[24]!.text).toMatch(/\d+ more line/);
  });
});

describe("buildPatchDiff", () => {
  test("add op: emits header row then all-added content lines", () => {
    const ops: PatchOp[] = [{ type: "add", path: "src/new.ts", content: "line1\nline2" }];
    const lines = buildPatchDiff(ops);
    expect(lines.some((l) => l.sign === " " && l.text.includes("add") && l.text.includes("src/new.ts"))).toBe(true);
    expect(lines.some((l) => l.sign === "+" && l.text === "line1")).toBe(true);
    expect(lines.some((l) => l.sign === "+" && l.text === "line2")).toBe(true);
    expect(lines.some((l) => l.sign === "-")).toBe(false);
  });
  test("delete op: emits header row and a deleted-file marker", () => {
    const ops: PatchOp[] = [{ type: "delete", path: "src/old.ts" }];
    const lines = buildPatchDiff(ops);
    expect(lines.some((l) => l.sign === " " && l.text.includes("delete") && l.text.includes("src/old.ts"))).toBe(true);
    expect(lines.some((l) => l.sign === "-")).toBe(true);
  });
  test("update op: emits header row then edit diff lines", () => {
    const ops: PatchOp[] = [{ type: "update", path: "src/app.ts", hunks: [{ oldStr: "const x = 1;", newStr: "const x = 2;" }] }];
    const lines = buildPatchDiff(ops);
    expect(lines.some((l) => l.sign === " " && l.text.includes("update") && l.text.includes("src/app.ts"))).toBe(true);
    expect(lines.some((l) => l.sign === "-" && l.text === "const x = 1;")).toBe(true);
    expect(lines.some((l) => l.sign === "+" && l.text === "const x = 2;")).toBe(true);
  });
  test("update op with moveTo: header includes the rename arrow", () => {
    const ops: PatchOp[] = [{ type: "update", path: "src/old.ts", moveTo: "src/new.ts", hunks: [{ oldStr: "a", newStr: "b" }] }];
    const lines = buildPatchDiff(ops);
    const header = lines.find((l) => l.sign === " " && l.text.includes("src/old.ts"));
    expect(header).toBeDefined();
    expect(header!.text).toContain("src/new.ts");
  });
  test("multiple ops are separated by a blank context line", () => {
    const ops: PatchOp[] = [
      { type: "add", path: "a.ts", content: "x" },
      { type: "delete", path: "b.ts" },
    ];
    const sepIdx = buildPatchDiff(ops).findIndex((l) => l.sign === " " && l.text === "");
    expect(sepIdx).toBeGreaterThan(0);
  });
  test("empty ops array returns empty array", () => {
    expect(buildPatchDiff([])).toEqual([]);
  });
  test("caps total output at MAX_LINES + overflow marker", () => {
    const bigContent = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
    const ops: PatchOp[] = [{ type: "add", path: "big.ts", content: bigContent }];
    const lines = buildPatchDiff(ops);
    expect(lines.length).toBe(25);
    expect(lines[24]!.text).toMatch(/\d+ more line/);
  });
});

describe("lineOf", () => {
  const haystack = "alpha\nbeta\ngamma\ndelta";
  test("returns 1-based line number for exact multi-line match", () => {
    expect(lineOf(haystack, "beta\ngamma")).toBe(2);
  });
  test("returns correct line for single-line exact match", () => {
    expect(lineOf(haystack, "gamma")).toBe(3);
  });
  test("returns line 1 when match is at the very start", () => {
    expect(lineOf(haystack, "alpha")).toBe(1);
  });
  test("falls back to first-line match when full needle is not found", () => {
    expect(lineOf(haystack, "beta\nNOT_THERE")).toBe(2);
  });
  test("returns undefined when neither full needle nor first line is found", () => {
    expect(lineOf(haystack, "totally missing")).toBeUndefined();
  });
  test("returns undefined for empty haystack", () => {
    expect(lineOf("", "anything")).toBeUndefined();
  });
});

describe("diffStat", () => {
  test("counts additions and deletions correctly", () => {
    const { add, del } = diffStat(buildEditDiff("a\nb\nc", "a\nB\nC"));
    expect(add).toBe(2);
    expect(del).toBe(2);
  });
  test("returns zero counts for no changes", () => {
    expect(diffStat(buildEditDiff("same", "same"))).toEqual({ add: 0, del: 0 });
  });
  test("counts only additions for a write diff, zero deletions", () => {
    const { add, del } = diffStat(buildWriteDiff("x\ny"));
    expect(add).toBe(2);
    expect(del).toBe(0);
  });
  test("context lines (sign=space) are never counted", () => {
    const { add, del } = diffStat(buildEditDiff("a\nb\nc", "a\nB\nc"));
    expect(add).toBe(1);
    expect(del).toBe(1);
  });
  test("handles empty input array", () => {
    expect(diffStat([])).toEqual({ add: 0, del: 0 });
  });
});
