import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectVerifyCommands, summarizeChecks, extractFailingFiles, type CheckResult } from "./verify.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "klaat-verify-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const write = (name: string, content = "{}") => writeFileSync(join(dir, name), content);

describe("detectVerifyCommands", () => {
  test("bun project → bun test + tsc typecheck", () => {
    write("package.json", JSON.stringify({ scripts: {} }));
    write("bun.lock", "");
    write("tsconfig.json");
    const c = detectVerifyCommands(dir);
    expect(c.test).toEqual({ cmd: "bun test", runner: "Bun" });
    expect(c.typecheck).toEqual({ cmd: "bunx tsc --noEmit", runner: "tsc" });
  });

  test("npm typecheck script is preferred over bare tsc", () => {
    write("package.json", JSON.stringify({ scripts: { typecheck: "tsc -p ." } }));
    write("tsconfig.json");
    expect(detectVerifyCommands(dir).typecheck).toEqual({ cmd: "npm run typecheck", runner: "typecheck" });
  });

  test("pytest project", () => {
    write("pyproject.toml", "");
    const c = detectVerifyCommands(dir);
    expect(c.test).toEqual({ cmd: "python -m pytest -q", runner: "pytest" });
    expect(c.typecheck).toBeNull();
  });

  test("placeholder npm test script is ignored", () => {
    write("package.json", JSON.stringify({ scripts: { test: 'echo "no tests" && exit 1' } }));
    expect(detectVerifyCommands(dir).test).toBeNull();
  });

  test("empty project → nothing", () => {
    const c = detectVerifyCommands(dir);
    expect(c.test).toBeNull();
    expect(c.typecheck).toBeNull();
  });
});

describe("summarizeChecks", () => {
  const mk = (runner: string, ok: boolean, code = ok ? 0 : 1): CheckResult => ({ runner, ok, code, output: "" });
  test("all pass", () => {
    expect(summarizeChecks([mk("tsc", true), mk("Bun", true)])).toEqual({ line: "✓ tsc · ✓ Bun", allOk: true });
  });
  test("one fails carries exit code and flips allOk", () => {
    const r = summarizeChecks([mk("tsc", true), mk("Bun", false, 2)]);
    expect(r.allOk).toBe(false);
    expect(r.line).toBe("✓ tsc · ✗ Bun (exit 2)");
  });
});

describe("extractFailingFiles", () => {
  const fail = (output: string): CheckResult => ({ runner: "tsc", ok: false, code: 2, output });
  test("tsc path(l,c): error", () => {
    const out = "src/store/useAuthStore.ts(60,7): error TS2322: Type 'null'...\nsrc/app/page.tsx(12,3): error TS1117: dup";
    expect([...extractFailingFiles([fail(out)])]).toEqual(["src/store/useAuthStore.ts", "src/app/page.tsx"]);
  });
  test("pytest FAILED", () => {
    expect([...extractFailingFiles([fail("FAILED tests/test_api.py::test_x - assert")])]).toEqual(["tests/test_api.py"]);
  });
  test("passing results contribute nothing", () => {
    expect(extractFailingFiles([{ runner: "tsc", ok: true, code: 0, output: "src/x.ts(1,1): error nope" }]).size).toBe(0);
  });
});
