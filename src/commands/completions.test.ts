import { expect, test, describe } from "bun:test";
import {
  getCompletionScript,
  isCompletionShell,
  COMPLETION_SHELLS,
  resolveCompletions,
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

  test("zsh chat completes a project directory (matches CLI [dir] arg)", () => {
    // Bot suggested '1:prompt:' — incorrect: `chat [dir]` opens a project directory.
    const script = getCompletionScript("zsh");
    expect(script).toContain("_files -/");
  });

  test("fish completes both binaries", () => {
    const script = getCompletionScript("fish");
    expect(script).toContain("complete -c klaatai");
    expect(script).toContain("complete -c klaatcode");
  });

  // The checked-in scripts under completions/ are what packagers ship; the embedded
  // strings are what `klaatai completions <shell>` prints. They drifted once: the zsh
  // file's --model tier list still read `(nano fast code reason heavy)` after titan was
  // added to the generator, so tab-completion denied a tier the CLI accepts.
  test("the checked-in completions/ scripts match the embedded generator", async () => {
    const dir = `${import.meta.dir}/../../completions`;
    for (const shell of COMPLETION_SHELLS) {
      const onDisk = await Bun.file(`${dir}/klaatai.${shell}`).text();
      expect(onDisk, `completions/klaatai.${shell} is stale — regenerate it`)
        .toBe(getCompletionScript(shell));
    }
  });

  // zsh is the only shell that enumerates the tier VALUES, so it is the only one that
  // can go stale when a tier is added. Assert the whole ladder, in order.
  test("zsh --model offers the full tier ladder including titan", () => {
    const script = getCompletionScript("zsh");
    const line = script.split("\n").find(l => l.includes("--model[Force routing tier]"));
    expect(line, "zsh script has no --model tier completion").toBeDefined();
    const values = line!.match(/:tier:\(([^)]*)\)/)?.[1]?.split(/\s+/) ?? [];
    expect(values).toEqual(["nano", "fast", "code", "reason", "heavy", "titan"]);
  });

  test("resolveCompletions rejects unknown shells with a usage error", () => {
    const bad = resolveCompletions("bogus");
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error).toContain("Unknown shell: bogus");
      expect(bad.error).toContain("bash|zsh|fish");
    }
  });

  test("resolveCompletions accepts case-insensitive shell names", () => {
    const ok = resolveCompletions("Zsh");
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.script).toContain("#compdef");
  });
});
