import { afterEach, describe, expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";

// We patch `node:child_process.spawnSync` so the platform-specific clipboard
// readers can be driven without a real OS clipboard. The module under test
// captures spawnSync at import time, so we register the mock before importing.

type SpawnResult = { status: number | null; stdout: string | Buffer; stderr?: string | Buffer };

let nextSpawn: SpawnResult | null = null;
let spawnCalls: { cmd: string; args: string[] }[] = [];

mock.module("node:child_process", () => ({
  spawnSync: (cmd: string, args: string[]): SpawnResult => {
    spawnCalls.push({ cmd, args });
    return nextSpawn ?? { status: 1, stdout: "" };
  },
}));

mock.module("node:fs", () => ({
  readFileSync: () => (nextSpawn?.stdout ?? Buffer.alloc(0)),
  rmSync: () => {},
}));

const { readClipboardImage, MAX_IMAGE_BYTES } =
  await import("./clipboard-image.js") as {
    readClipboardImage: () =>
      | { ok: true; image: { b64: string; mime: string } }
      | { ok: false; reason: "empty" }
      | { ok: false; reason: "too_large"; sizeBytes: number };
    MAX_IMAGE_BYTES: number;
  };

const MB = 1024 * 1024;

afterEach(() => {
  nextSpawn = null;
  spawnCalls = [];
});

describe("readClipboardImage — sized result discrimination", () => {
  test("reports `too_large` with byte count when PNG exceeds the cap", () => {
    // 13.9MB of bytes, already over the 8MB cap. Build a fake PNG header so
    // the mac regex matches; the rest of the bytes are discarded.
    const big = Buffer.alloc(MAX_IMAGE_BYTES + 5, 0);
    big.writeUInt8(0x89, 0);
    nextSpawn = { status: 0, stdout: `«data PNGf${big.toString("hex")}»` };

    // Force darwin path regardless of host platform by stubbing process.platform.
    const saved = (process as { platform: string }).platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

    const res = readClipboardImage();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("too_large");
      if (res.reason === "too_large") {
        expect(res.sizeBytes).toBe(MAX_IMAGE_BYTES + 5);
        expect((res.sizeBytes / MB).toFixed(1)).toBe("8.0");
      }
    }

    Object.defineProperty(process, "platform", { value: saved, configurable: true });
  });

  test("returns a success result with base64 PNG when bytes fit", () => {
    // 1KB of bytes with a PNG-style header.
    const small = Buffer.alloc(1024, 0);
    small.writeUInt8(0x89, 0);
    nextSpawn = { status: 0, stdout: `«data PNGf${small.toString("hex")}»` };

    const saved = (process as { platform: string }).platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

    const res = readClipboardImage();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.image.mime).toBe("image/png");
      // base64 of our 1KB buffer — round-trips cleanly.
      expect(Buffer.from(res.image.b64, "base64").length).toBe(1024);
    }

    Object.defineProperty(process, "platform", { value: saved, configurable: true });
  });

  test("empty clipboard yields reason `empty`, not too_large", () => {
    nextSpawn = { status: 1, stdout: "" }; // osascript failed = nothing on clipboard
    const saved = (process as { platform: string }).platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

    const res = readClipboardImage();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("empty");

    Object.defineProperty(process, "platform", { value: saved, configurable: true });
  });

  test("MAX_IMAGE_BYTES is exactly 8 MiB (sanity guard against regressions)", () => {
    expect(MAX_IMAGE_BYTES).toBe(8 * 1024 * 1024);
  });
});