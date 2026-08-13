import { describe, expect, test } from "bun:test";
import { buildUpdateInfo, compareSemver, parseVersionOutput } from "./update.js";

describe("compareSemver", () => {
  test("orders plain versions", () => {
    expect(compareSemver("2.0.0", "2.1.0")).toBe(-1);
    expect(compareSemver("2.1.0", "2.0.9")).toBe(1);
    expect(compareSemver("2.1.0", "2.1.0")).toBe(0);
    expect(compareSemver("2.0.10", "2.0.9")).toBe(1); // numeric, not lexical
    expect(compareSemver("10.0.0", "9.9.9")).toBe(1);
  });

  test("handles v prefix and whitespace", () => {
    expect(compareSemver("v2.0.0", "2.0.0")).toBe(0);
    expect(compareSemver(" 2.0.0 ", "v2.0.1")).toBe(-1);
  });

  test("release beats prerelease of same triple", () => {
    expect(compareSemver("2.1.0-beta.1", "2.1.0")).toBe(-1);
    expect(compareSemver("2.1.0", "2.1.0-rc.1")).toBe(1);
    expect(compareSemver("2.1.0-alpha", "2.1.0-beta")).toBe(-1);
  });

  test("garbage input treated as 0.0.0", () => {
    expect(compareSemver("nonsense", "0.0.1")).toBe(-1);
    expect(compareSemver("nonsense", "0.0.0")).toBe(0);
  });
});

describe("parseVersionOutput", () => {
  test("pulls the version out of --version output", () => {
    expect(parseVersionOutput("2.4.2\n")).toBe("2.4.2");
    expect(parseVersionOutput("klaatcode v2.4.3 (bun)")).toBe("2.4.3");
    expect(parseVersionOutput("klaatcode 2.4.3-rc.1")).toBe("2.4.3-rc.1");
  });

  test("null when there is no version", () => {
    expect(parseVersionOutput("command not found")).toBeNull();
  });
});

describe("buildUpdateInfo", () => {
  test("flags an available update", () => {
    const i = buildUpdateInfo("2.4.2", "2.4.3");
    expect(i.updateAvailable).toBe(true);
    expect(i.mandatory).toBe(false);
  });

  test("no update when current is latest or newer", () => {
    expect(buildUpdateInfo("2.4.3", "2.4.3").updateAvailable).toBe(false);
    expect(buildUpdateInfo("2.6.0", "2.4.3").updateAvailable).toBe(false);
  });

  test("mandatory below the floor", () => {
    const i = buildUpdateInfo("1.15.3", "2.4.3", "2.0.0");
    expect(i.mandatory).toBe(true);
  });

  test("not mandatory at or above the floor", () => {
    expect(buildUpdateInfo("2.0.0", "2.4.3", "2.0.0").mandatory).toBe(false);
    expect(buildUpdateInfo("2.4.2", "2.4.3", "2.0.0").mandatory).toBe(false);
  });

  test("floor newer than the latest release is ignored — it would strand everyone", () => {
    expect(buildUpdateInfo("2.4.2", "2.4.3", "9.9.9").mandatory).toBe(false);
  });
});
