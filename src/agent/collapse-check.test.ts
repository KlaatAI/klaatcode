import { describe, expect, test } from "bun:test";
import { collectCriticalState, checkSummaryCoverage } from "./collapse-check.js";
import type { Message } from "../api/client.js";

describe("collectCriticalState", () => {
  test("captures the last substantial user message as task intent", () => {
    const span: Message[] = [
      { role: "user", content: "fix the token refresh race condition in the auth client module" },
      { role: "assistant", content: "on it" },
      { role: "user", content: "yes" }, // short follow-up must not win
    ];
    const s = collectCriticalState(span, []);
    expect(s.taskIntent).toContain("token refresh race condition");
  });

  test("falls back to a short user message when nothing substantial exists", () => {
    const s = collectCriticalState([{ role: "user", content: "hi" }], []);
    expect(s.taskIntent).toBe("hi");
  });

  test("ignores flattened tool-result pseudo-user messages", () => {
    const span: Message[] = [
      { role: "user", content: "rename the parser module and update every caller" },
      { role: "user", content: "[tool result]\nsome long tool output that is not the task" },
    ];
    const s = collectCriticalState(span, []);
    expect(s.taskIntent).toContain("rename the parser");
  });

  test("dedupes and caps modified files", () => {
    const files = ["a.ts", "a.ts", ...Array.from({ length: 30 }, (_, i) => `f${i}.ts`)];
    const s = collectCriticalState([], files);
    expect(s.files.filter(f => f === "a.ts")).toHaveLength(1);
    expect(s.files.length).toBeLessThanOrEqual(20);
  });

  test("empty span → null intent", () => {
    expect(collectCriticalState([], []).taskIntent).toBeNull();
  });
});

describe("checkSummaryCoverage", () => {
  test("faithful summary passes clean", () => {
    const state = {
      taskIntent: "fix the token refresh race condition in the auth client",
      files: ["src/auth/client.ts"],
    };
    const summary =
      "Task: fix the token refresh race condition in the auth client. " +
      "Edited src/auth/client.ts to serialize refresh calls.";
    expect(checkSummaryCoverage(summary, state)).toHaveLength(0);
  });

  test("summary that dropped the task intent is flagged", () => {
    const state = {
      taskIntent: "migrate the billing webhook verification to the new signature scheme",
      files: [],
    };
    const summary = "General discussion about code quality. Some files were read.";
    const missing = checkSummaryCoverage(summary, state);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain("task intent");
  });

  test("summary that forgot modified files is flagged", () => {
    const state = { taskIntent: null, files: ["src/api/quota.ts", "src/screens/cost.ts"] };
    const summary = "We changed quota handling in src/api/quota.ts.";
    const missing = checkSummaryCoverage(summary, state);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain("cost.ts");
    expect(missing[0]).not.toContain("quota.ts");
  });

  test("file matching is by basename (summaries rarely carry full paths)", () => {
    const state = { taskIntent: null, files: ["deep/nested/dir/widget.ts"] };
    expect(checkSummaryCoverage("Updated widget.ts to fix the render bug.", state)).toHaveLength(0);
  });

  test("no critical state → nothing to flag", () => {
    expect(checkSummaryCoverage("anything", { taskIntent: null, files: [] })).toHaveLength(0);
  });
});
