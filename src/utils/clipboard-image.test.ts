import { describe, expect, test } from "bun:test";
import { wrapPng, MAX_IMAGE_BYTES } from "./clipboard-image.js";

const MB = 1024 * 1024;

describe("wrapPng — sized result discrimination", () => {
  test("too large → { ok:false, reason:'too_large', sizeBytes } with real byte count", () => {
    const size = MAX_IMAGE_BYTES + 5;
    const buf = Buffer.alloc(size);
    buf.writeUInt8(0x89, 0); // PNG-ish header byte (cosmetic only)

    const res = wrapPng(buf);
    expect(res).not.toBeNull();
    expect(res!.ok).toBe(false);
    if (res && !res.ok) {
      expect(res.reason).toBe("too_large");
      if (res.reason === "too_large") {
        expect(res.sizeBytes).toBe(size);
        // 8MB + 5 bytes rounds to 8.0 MB at one decimal.
        expect((res.sizeBytes / MB).toFixed(1)).toBe("8.0");
      }
    }
  });

  test("under the cap → success result with base64 PNG + mime", () => {
    const buf = Buffer.alloc(1024, 0x42);
    const res = wrapPng(buf);
    expect(res).not.toBeNull();
    expect(res!.ok).toBe(true);
    if (res && res.ok) {
      expect(res.image.mime).toBe("image/png");
      // base64 of our 1024-byte buffer round-trips cleanly.
      expect(Buffer.from(res.image.b64, "base64").length).toBe(1024);
    }
  });

  test("exactly the cap → allowed (boundary is inclusive)", () => {
    const buf = Buffer.alloc(MAX_IMAGE_BYTES, 0);
    const res = wrapPng(buf);
    expect(res).not.toBeNull();
    expect(res!.ok).toBe(true);
  });

  test("one byte over the cap → too_large", () => {
    const buf = Buffer.alloc(MAX_IMAGE_BYTES + 1, 0);
    const res = wrapPng(buf);
    expect(res).not.toBeNull();
    expect(res!.ok).toBe(false);
    if (res && !res.ok) expect(res.reason).toBe("too_large");
  });

  test("empty buffer → null (collapsed to reason:'empty' by the caller)", () => {
    expect(wrapPng(Buffer.alloc(0))).toBeNull();
  });

  test("MAX_IMAGE_BYTES is exactly 8 MiB (guard against regressions)", () => {
    expect(MAX_IMAGE_BYTES).toBe(8 * 1024 * 1024);
  });
});