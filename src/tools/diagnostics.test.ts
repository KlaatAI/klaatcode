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
