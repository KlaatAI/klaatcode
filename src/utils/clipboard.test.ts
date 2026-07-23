import { describe, expect, test } from "bun:test";
import { copyToClipboard, type SpawnSyncFn } from "./clipboard";

function fakeSpawn(
  plan: Record<string, { status?: number | null; error?: Error }>,
): SpawnSyncFn {
  return (command) => {
    const r = plan[command] ?? { status: 1, error: new Error("ENOENT") };
    return {
      status: r.status ?? null,
      error: r.error,
      signal: null,
      output: [null, "", ""],
      pid: 0,
      stdout: "",
      stderr: "",
    };
  };
}

describe("copyToClipboard", () => {
  const original = process.platform;

  test("darwin: succeeds only when pbcopy exits 0", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    expect(copyToClipboard("hi", fakeSpawn({ pbcopy: { status: 0 } }))).toBe(true);
    expect(copyToClipboard("hi", fakeSpawn({ pbcopy: { status: 1 } }))).toBe(false);
    expect(copyToClipboard("hi", fakeSpawn({ pbcopy: { error: new Error("ENOENT") } }))).toBe(false);
    Object.defineProperty(process, "platform", { value: original });
  });

  test("win32: succeeds only when clip exits 0", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    expect(copyToClipboard("hi", fakeSpawn({ clip: { status: 0 } }))).toBe(true);
    expect(copyToClipboard("hi", fakeSpawn({ clip: { status: 1 } }))).toBe(false);
    Object.defineProperty(process, "platform", { value: original });
  });

  test("linux: falls back from xclip to xsel; false when both fail", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    expect(copyToClipboard("hi", fakeSpawn({
      xclip: { status: 0 },
    }))).toBe(true);
    expect(copyToClipboard("hi", fakeSpawn({
      xclip: { error: new Error("ENOENT") },
      xsel: { status: 0 },
    }))).toBe(true);
    expect(copyToClipboard("hi", fakeSpawn({
      xclip: { error: new Error("ENOENT") },
      xsel: { error: new Error("ENOENT") },
    }))).toBe(false);
    Object.defineProperty(process, "platform", { value: original });
  });
});
