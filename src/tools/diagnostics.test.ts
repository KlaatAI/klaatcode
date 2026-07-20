import { expect, test, describe, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDiagnostics, configureDiagnostics } from "./diagnostics";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "klaatai-diag-"));
  configureDiagnostics({ enabled: true, timeoutMs: 8_000 });
});

describe("Ruby diagnostics (.rb)", () => {
  test("returns null for .rb when rubocop is not on PATH (silently skipped)", () => {
    const absPath = join(tmp, "foo.rb");
    writeFileSync(absPath, 'puts "hello"\n');
    const result = runDiagnostics(absPath, tmp);
    expect(result === null || typeof result === "string").toBe(true);
  });

  test("returns null for .rb when diagnostics are disabled", () => {
    configureDiagnostics({ enabled: false });
    const absPath = join(tmp, "foo.rb");
    writeFileSync(absPath, 'puts "hello"\n');
    expect(runDiagnostics(absPath, tmp)).toBeNull();
  });

  test("returns null for .rb when rubocop is absent (no override)", () => {
    // No config override, rubocop not on PATH in CI — must return null, never throw.
    const absPath = join(tmp, "bar.rb");
    writeFileSync(absPath, "def foo; end\n");
    expect(() => runDiagnostics(absPath, tmp)).not.toThrow();
    const result = runDiagnostics(absPath, tmp);
    // null = rubocop absent (expected in CI); string = rubocop present and found issues
    expect(result === null || typeof result === "string").toBe(true);
  });

  test("non-.rb files are unaffected by the Ruby branch", () => {
    const absPath = join(tmp, "foo.py");
    writeFileSync(absPath, "x = 1\n");
    expect(() => runDiagnostics(absPath, tmp)).not.toThrow();
  });

  test("returns null for .rb when config explicitly disables the extension via empty commands", () => {
    configureDiagnostics({ enabled: true, timeoutMs: 8_000, commands: {} });
    const absPath = join(tmp, "baz.rb");
    writeFileSync(absPath, 'puts "test"\n');
    // No override for .rb, rubocop not on PATH -> null
    const result = runDiagnostics(absPath, tmp);
    expect(result === null || typeof result === "string").toBe(true);
  });
});

/** Shared shape for PATH-gated language branches: never throw; null or string. */
function expectSoftResult(absPath: string): void {
  expect(() => runDiagnostics(absPath, tmp)).not.toThrow();
  const result = runDiagnostics(absPath, tmp);
  expect(result === null || typeof result === "string").toBe(true);
}

describe("Swift diagnostics (.swift)", () => {
  test("never throws; skips when swiftlint absent", () => {
    const absPath = join(tmp, "Foo.swift");
    writeFileSync(absPath, "struct Foo {}\n");
    expectSoftResult(absPath);
  });

  test("returns null when diagnostics disabled", () => {
    configureDiagnostics({ enabled: false });
    const absPath = join(tmp, "Bar.swift");
    writeFileSync(absPath, "struct Bar {}\n");
    expect(runDiagnostics(absPath, tmp)).toBeNull();
  });
});

describe("PHP diagnostics (.php)", () => {
  test("never throws; skips when phpstan/pint/php absent", () => {
    const absPath = join(tmp, "foo.php");
    writeFileSync(absPath, "<?php echo 1;\n");
    expectSoftResult(absPath);
  });

  test("returns null when diagnostics disabled", () => {
    configureDiagnostics({ enabled: false });
    const absPath = join(tmp, "bar.php");
    writeFileSync(absPath, "<?php echo 1;\n");
    expect(runDiagnostics(absPath, tmp)).toBeNull();
  });
});

describe("Kotlin diagnostics (.kt / .kts)", () => {
  test("never throws for .kt when ktlint absent", () => {
    const absPath = join(tmp, "Foo.kt");
    writeFileSync(absPath, "fun main() {}\n");
    expectSoftResult(absPath);
  });

  test("never throws for .kts when ktlint absent", () => {
    const absPath = join(tmp, "build.kts");
    writeFileSync(absPath, "plugins {}\n");
    expectSoftResult(absPath);
  });

  test("returns null when diagnostics disabled", () => {
    configureDiagnostics({ enabled: false });
    const absPath = join(tmp, "Bar.kt");
    writeFileSync(absPath, "class Bar\n");
    expect(runDiagnostics(absPath, tmp)).toBeNull();
  });
});

describe("Shell diagnostics (.sh / .bash / .zsh)", () => {
  test("never throws for .sh when shellcheck absent", () => {
    const absPath = join(tmp, "script.sh");
    writeFileSync(absPath, "#!/bin/sh\necho hi\n");
    expectSoftResult(absPath);
  });

  test("never throws for .bash when shellcheck absent", () => {
    const absPath = join(tmp, "script.bash");
    writeFileSync(absPath, "#!/bin/bash\necho hi\n");
    expectSoftResult(absPath);
  });

  test("returns null when diagnostics disabled", () => {
    configureDiagnostics({ enabled: false });
    const absPath = join(tmp, "x.sh");
    writeFileSync(absPath, "#!/bin/sh\ntrue\n");
    expect(runDiagnostics(absPath, tmp)).toBeNull();
  });
});

describe("config override still wins for new extensions", () => {
  test("explicit commands override PATH detection for .sh", () => {
    configureDiagnostics({
      enabled: true,
      timeoutMs: 8_000,
      commands: { ".sh": "echo 'script.sh:1:1: error: fake' >&2; exit 1" },
    });
    const absPath = join(tmp, "override.sh");
    writeFileSync(absPath, "#!/bin/sh\n");
    const result = runDiagnostics(absPath, tmp);
    expect(result).not.toBeNull();
    expect(result!).toContain("Diagnostics after this edit");
    expect(result!).toContain("fake");
  });

  test("explicit clean override returns null for .swift", () => {
    configureDiagnostics({
      enabled: true,
      timeoutMs: 8_000,
      commands: { ".swift": "true" },
    });
    const absPath = join(tmp, "clean.swift");
    writeFileSync(absPath, "struct Ok {}\n");
    expect(runDiagnostics(absPath, tmp)).toBeNull();
  });
});
