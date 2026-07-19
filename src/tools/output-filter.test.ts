import { describe, expect, test, beforeEach } from "bun:test";
import { filterCommandOutput, setOutputFilterEnabled } from "./output-filter.js";

// Filter skips inputs under 400 chars — pad small fixtures past the gate.
const PAD = "x".repeat(80);
function pad(lines: string[]): string {
  return [...lines, ...Array(5).fill(PAD).map((p, i) => `${p}${i}`)].join("\n");
}

beforeEach(() => setOutputFilterEnabled(true));

describe("filterCommandOutput", () => {
  test("returns raw when disabled", () => {
    setOutputFilterEnabled(false);
    const noisy = pad(Array(50).fill("same line"));
    expect(filterCommandOutput(noisy)).toBe(noisy);
  });

  test("returns raw for short output", () => {
    const s = "ok\nok\nok\nok";
    expect(filterCommandOutput(s)).toBe(s);
  });

  test("empty input unchanged", () => {
    expect(filterCommandOutput("")).toBe("");
  });

  test("collapses progress-bar runs to the final frame", () => {
    const frames = Array.from({ length: 60 }, (_, i) =>
      `Downloading package [${"=".repeat(Math.floor(i / 2))}>${" ".repeat(30 - Math.floor(i / 2))}] ${i + 40}%`);
    const out = filterCommandOutput(pad(["start", ...frames, "done installing"]));
    expect(out).toContain("start");
    expect(out).toContain("done installing");
    expect(out).toContain("99%");          // final frame kept
    expect(out).not.toContain(" 40%");     // early frames dropped
    expect(out).toContain("output filter");
  });

  test("carriage-return overwrites keep only final state", () => {
    const line = Array.from({ length: 40 }, (_, i) => `progress ${i}%`).join("\r");
    const out = filterCommandOutput(pad(["before", line, "after"]));
    expect(out).toContain("progress 39%");
    expect(out).not.toContain("progress 5%\rprogress");
    expect(out).toContain("before");
    expect(out).toContain("after");
  });

  test("strips ANSI color codes", () => {
    const colored = Array(20).fill("\x1b[32mgreen line of output text here\x1b[0m unique");
    const withIdx = colored.map((l, i) => `${l} ${i}`);
    const out = filterCommandOutput(pad(withIdx));
    expect(out).not.toContain("\x1b[32m");
    expect(out).toContain("green line of output text here");
  });

  test("dedupes consecutive identical lines", () => {
    const out = filterCommandOutput(
      pad(["head", ...Array(30).fill("Warning: peer dep mismatch in module foo"), "tail"]));
    expect(out).toContain("Warning: peer dep mismatch in module foo");
    expect(out).toContain("repeated 29 more times");
    expect(out).toContain("head");
    expect(out).toContain("tail");
    // Only one instance of the warning line remains.
    expect(out.split("Warning: peer dep mismatch").length).toBe(2);
  });

  test("collapses passing tests, keeps failures verbatim", () => {
    const passes = Array.from({ length: 40 }, (_, i) => `✓ widget renders case ${i} correctly (2 ms)`);
    const failure = [
      "✗ widget handles null input",
      "  Expected: 42",
      "  Received: undefined",
      "    at src/widget.test.ts:88",
    ];
    const summary = "Tests: 1 failed, 40 passed, 41 total";
    const out = filterCommandOutput(pad([...passes, ...failure, summary]));
    expect(out).toContain("40 passing tests — collapsed");
    expect(out).not.toContain("case 17");                      // pass detail gone
    expect(out).toContain("✗ widget handles null input");      // failure kept
    expect(out).toContain("Received: undefined");
    expect(out).toContain(summary);                            // summary kept
  });

  test("short passing runs are kept, not collapsed", () => {
    const lines = ["✓ a passes fine", "✓ b passes fine", "✓ c passes fine", "1 more line of real output"];
    const out = filterCommandOutput(pad(lines));
    expect(out).toContain("✓ a passes fine");
    expect(out).not.toContain("collapsed");
  });

  test("keeps [exit N] and [stderr] structural lines", () => {
    const out = filterCommandOutput(
      pad(["[exit 1]", ...Array(30).fill("some repeated error context line"), "[stderr]", "real error: boom"]));
    expect(out).toContain("[exit 1]");
    expect(out).toContain("[stderr]");
    expect(out).toContain("real error: boom");
  });

  test("clean unique output passes through without a filter marker", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `unique meaningful line number ${i} with content`);
    const out = filterCommandOutput(pad(lines));
    expect(out).not.toContain("output filter");
    for (const l of lines) expect(out).toContain(l);
  });

  test("pytest verbose run collapses PASSED, keeps FAILED", () => {
    const lines = [
      ...Array.from({ length: 25 }, (_, i) => `tests/test_api.py::test_case_${i} PASSED`),
      "tests/test_api.py::test_auth FAILED",
      "E   AssertionError: expected 200 got 500",
      "==== 1 failed, 25 passed in 3.2s ====",
    ];
    const out = filterCommandOutput(pad(lines));
    expect(out).toContain("25 passing tests — collapsed");
    expect(out).toContain("test_auth FAILED");
    expect(out).toContain("AssertionError: expected 200 got 500");
    expect(out).toContain("1 failed, 25 passed");
  });

  test("git clone progress collapses", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `Receiving objects:  ${i * 2}% (${i * 20}/1000)`);
    const out = filterCommandOutput(pad(["Cloning into 'repo'...", ...lines, "done."]));
    expect(out).toContain("Cloning into 'repo'...");
    expect(out).toContain("98%");
    expect(out).not.toContain(" 4% ");
  });
});
