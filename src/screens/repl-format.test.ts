import { describe, expect, test } from "bun:test";
import { fmtUsd, runningPhrase, parseClamp, describeClamp } from "./repl-format.js";

describe("fmtUsd", () => {
  test("scales precision by magnitude", () => {
    expect(fmtUsd(0.5)).toBe("$0.50");
    expect(fmtUsd(0.033)).toBe("$0.033");
    expect(fmtUsd(0.0004)).toBe("$0.0004");
    expect(fmtUsd(0)).toBe("$0.0000");
  });
});

describe("runningPhrase", () => {
  test("aggregates and pluralizes by category", () => {
    expect(runningPhrase(["read_file"])).toBe("Reading 1 file");
    expect(runningPhrase(["read_file", "run_command", "run_command"]))
      .toBe("Reading 1 file, running 2 shell commands");
    expect(runningPhrase(["edit_file", "multi_edit"])).toBe("Editing 2 files");
    expect(runningPhrase([])).toBe("Working");
  });
});

describe("parseClamp", () => {
  test("detects plan clamp and cap, ignores no-op", () => {
    expect(parseClamp("hint_clamped:heavy->code(plan:free)")).toEqual({
      from: "heavy", to: "code", why: "plan:free", kind: "plan",
    });
    expect(parseClamp("plan_enforced:heavy->reason")).toEqual({
      from: "heavy", to: "reason", kind: "cap",
    });
    expect(parseClamp("hint_clamped:code->code")).toBeNull();
    expect(parseClamp(undefined)).toBeNull();
    expect(parseClamp("nothing here")).toBeNull();
  });
});

describe("describeClamp", () => {
  test("cap vs plan wording", () => {
    expect(describeClamp({ from: "heavy", to: "reason", kind: "cap" })).toContain("limit reached");
    expect(describeClamp({ from: "heavy", to: "code", kind: "plan" })).toContain("isn't available on your plan");
  });
});
