import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatResumeHint,
  writeBootMarker,
  clearBootMarker,
  detectBootCrashLoop,
  fsyncSessionFile,
  restoreTerminalAfterCrash,
  installCrashHandler,
  _resetCrashHandlerForTests,
} from "./crash-handler.js";

describe("crash-handler", () => {
  const origHome = process.env["HOME"];

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "klaatai-crash-"));
    process.env["HOME"] = dir;
    _resetCrashHandlerForTests();
    clearBootMarker();
  });

  afterEach(() => {
    if (origHome !== undefined) process.env["HOME"] = origHome;
    else delete process.env["HOME"];
    _resetCrashHandlerForTests();
  });

  test("formatResumeHint includes session id and resume command", () => {
    const hint = formatResumeHint("2026-07-25T12-00-00-abcd");
    expect(hint).toContain("2026-07-25T12-00-00-abcd");
    expect(hint).toContain("klaatai --resume");
  });

  test("boot marker detects crash loop until cleared", () => {
    expect(detectBootCrashLoop()).toBe(false);
    writeBootMarker();
    expect(detectBootCrashLoop()).toBe(true);
    clearBootMarker();
    expect(detectBootCrashLoop()).toBe(false);
  });

  test("fsyncSessionFile succeeds on an existing file", () => {
    const file = join(process.env["HOME"]!, "session.jsonl");
    writeFileSync(file, '{"role":"user","content":"hi"}\n', "utf-8");
    expect(() => fsyncSessionFile(file)).not.toThrow();
  });

  test("restoreTerminalAfterCrash is safe to call", () => {
    expect(() => restoreTerminalAfterCrash()).not.toThrow();
  });

  test("installCrashHandler prints resume hint and exits on uncaughtException", () => {
    const stderr: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    let exitCode: number | undefined;
    const origExit = process.exit;
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error("exit");
    }) as typeof process.exit;

    installCrashHandler({
      getSessionId: () => "sess-123",
      getSessionFile: () => join(process.env["HOME"]!, "sess.jsonl"),
    });

    expect(() => process.emit("uncaughtException", new Error("boom"))).toThrow("exit");
    expect(exitCode).toBe(1);
    expect(stderr.join("")).toContain("sess-123");
    expect(stderr.join("")).toContain("klaatai --resume");

    process.stderr.write = origWrite;
    process.exit = origExit;
    _resetCrashHandlerForTests();
  });
});
