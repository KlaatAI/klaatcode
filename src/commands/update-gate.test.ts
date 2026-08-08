import { describe, expect, test } from "bun:test";
import { decideUpdateAction, type GateEnv } from "./update-gate.js";
import { buildUpdateInfo } from "../utils/update.js";

const env = (over: Partial<GateEnv> = {}): GateEnv => ({
  interactive: true,
  disabled: false,
  source: false,
  skipFloor: false,
  dismissed: false,
  ...over,
});

const AVAILABLE = buildUpdateInfo("2.4.2", "2.4.3");
const BELOW_FLOOR = buildUpdateInfo("1.15.3", "2.4.3", "2.0.0");
const UP_TO_DATE = buildUpdateInfo("2.4.3", "2.4.3");

describe("decideUpdateAction", () => {
  test("nothing to do when up to date or offline", () => {
    expect(decideUpdateAction(UP_TO_DATE, env())).toBe("skip");
    expect(decideUpdateAction(null, env())).toBe("skip");
  });

  test("prompts in an interactive terminal", () => {
    expect(decideUpdateAction(AVAILABLE, env())).toBe("prompt");
  });

  test("notifies instead of prompting without a TTY", () => {
    expect(decideUpdateAction(AVAILABLE, env({ interactive: false }))).toBe("notify");
  });

  test("opt-out silences an optional update", () => {
    expect(decideUpdateAction(AVAILABLE, env({ disabled: true }))).toBe("skip");
  });

  test("a declined version is not re-asked", () => {
    expect(decideUpdateAction(AVAILABLE, env({ dismissed: true }))).toBe("skip");
  });

  test("source checkouts never self-update", () => {
    expect(decideUpdateAction(AVAILABLE, env({ source: true }))).toBe("skip");
    expect(decideUpdateAction(BELOW_FLOOR, env({ source: true }))).toBe("skip");
  });

  test("below the floor is mandatory — opt-out and dismissal do not apply", () => {
    expect(decideUpdateAction(BELOW_FLOOR, env())).toBe("mandatory");
    expect(decideUpdateAction(BELOW_FLOOR, env({ disabled: true }))).toBe("mandatory");
    expect(decideUpdateAction(BELOW_FLOOR, env({ dismissed: true }))).toBe("mandatory");
  });

  test("mandatory needs a terminal — otherwise notify", () => {
    expect(decideUpdateAction(BELOW_FLOOR, env({ interactive: false }))).toBe("notify");
  });

  test("KLAATAI_SKIP_VERSION_GATE downgrades mandatory to a normal prompt", () => {
    expect(decideUpdateAction(BELOW_FLOOR, env({ skipFloor: true }))).toBe("prompt");
    expect(decideUpdateAction(BELOW_FLOOR, env({ skipFloor: true, disabled: true }))).toBe("skip");
  });
});
