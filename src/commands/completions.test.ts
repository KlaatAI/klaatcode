import { expect, test, describe } from "bun:test";
import {
  getCompletionScript,
  isCompletionShell,
  COMPLETION_SHELLS,
} from "./completions";

describe("completions", () => {
  test("recognizes bash/zsh/fish only", () => {
    expect(isCompletionShell("bash")).toBe(true);
    expect(isCompletionShell("zsh")).toBe(true);
    expect(isCompletionShell("fish")).toBe(true);
    expect(isCompletionShell("powershell")).toBe(false);
    expect(isCompletionShell("")).toBe(false);
  });

  test("exposes all three shells", () => {
    expect(COMPLETION_SHELLS).toEqual(["bash", "zsh", "fish"]);
  });

  for (const shell of COMPLETION_SHELLS) {
    test(`${shell} script covers both binary names and top-level commands`, () => {
      const script = getCompletionScript(shell);
      expect(script.endsWith("\n")).toBe(true);
      expect(script).toContain("klaatai");
      expect(script).toContain("klaatcode");
      for (const cmd of ["chat", "run", "login", "logout", "whoami", "upgrade", "serve", "web", "acp", "completions"]) {
        expect(script).toContain(cmd);
      }
      // Flag forms differ by shell (bash/zsh: --base-url; fish: -l base-url)
      expect(script.includes("--base-url") || script.includes("-l base-url")).toBe(true);
      expect(script.includes("--model") || script.includes("-l model")).toBe(true);
      expect(script.includes("--max-cost") || script.includes("-l max-cost")).toBe(true);
    });
  }

  test("bash registers complete for both binaries", () => {
    const script = getCompletionScript("bash");
    expect(script).toContain("complete -F _klaatai_completion klaatai");
    expect(script).toContain("complete -F _klaatai_completion klaatcode");
  });

  test("zsh uses #compdef for both binaries", () => {
    const script = getCompletionScript("zsh");
    expect(script).toContain("#compdef klaatai klaatcode");
    expect(script).toContain("compdef _klaatai klaatai klaatcode");
  });

  test("fish completes both binaries", () => {
    const script = getCompletionScript("fish");
    expect(script).toContain("complete -c klaatai");
    expect(script).toContain("complete -c klaatcode");
  });
});
