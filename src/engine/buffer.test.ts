/**
 * Renderer-corruption regression tests. Each case pins one of the defects
 * behind the "overlapping / messed-up UI during streaming" bug reports:
 * cursor-tracking drift after non-ASCII glyphs, wide-glyph self-erase,
 * full-frame re-emission, and missing atomic-frame guards.
 */

import { describe, test, expect } from "bun:test";
import { CellBuffer } from "./buffer.js";
import { charWidth } from "./input.js";

/** Run fn with stdout captured; returns everything written. */
function capture(fn: () => void): string {
  let out = "";
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: unknown }).write = (s: unknown) => { out += String(s); return true; };
  try { fn(); } finally {
    (process.stdout as { write: unknown }).write = orig;
  }
  return out;
}

describe("charWidth", () => {
  test("emoji-presentation symbols below U+1F300 are 2 columns", () => {
    expect(charWidth("⚡")).toBe(2); // U+26A1
    expect(charWidth("✅")).toBe(2); // U+2705
    expect(charWidth("⭐")).toBe(2); // U+2B50
    expect(charWidth("❌")).toBe(2); // U+274C
  });

  test("narrow UI glyphs stay 1 column", () => {
    expect(charWidth("●")).toBe(1); // U+25CF — sidebar status dot
    expect(charWidth("✦")).toBe(1); // U+2726 — build marker
    expect(charWidth("⠋")).toBe(1); // braille spinner frame
    expect(charWidth("│")).toBe(1); // box drawing
  });

  test("CJK and emoji proper are 2 columns", () => {
    expect(charWidth("中")).toBe(2);
    expect(charWidth("🚀")).toBe(2);
  });
});

describe("CellBuffer.flush", () => {
  test("an unchanged frame emits NOTHING — dirty flags alone must not force re-emission", () => {
    const buf = new CellBuffer(20, 2);
    buf.write(0, 0, "hello", {});
    capture(() => buf.flush());
    // Same content again (every render rewrites the back buffer).
    buf.clear();
    buf.write(0, 0, "hello", {});
    const second = capture(() => buf.flush());
    expect(second).toBe("");
  });

  test("after a non-ASCII glyph the next cell is explicitly positioned — no drift-by-trust", () => {
    const buf = new CellBuffer(20, 1);
    buf.write(0, 0, "a⚡b", {});
    const out = capture(() => buf.flush());
    // b sits at col 3 (a=1 + ⚡=2). The renderer must move there explicitly:
    // if the terminal advanced differently than charWidth guessed, an
    // unpositioned 'b' lands offset — the doubled-prefix corruption.
    expect(out).toContain("\x1b[1;4H");
  });

  test("the placeholder cell of a wide glyph is never overwritten with a space", () => {
    const buf = new CellBuffer(20, 1);
    buf.write(0, 0, "⚡x", {});
    const out = capture(() => buf.flush());
    // A write at the placeholder column (col 1 → CUP ;2H) would erase the
    // glyph's right half and blank the whole glyph on most terminals.
    expect(out).not.toContain("\x1b[1;2H");
    expect(out).toContain("⚡");
    expect(out).toContain("x");
  });

  test("frames are wrapped in synchronized-update guards", () => {
    const buf = new CellBuffer(10, 1);
    buf.write(0, 0, "hi", {});
    const out = capture(() => buf.flush());
    expect(out.startsWith("\x1b[?2026h")).toBe(true);
    expect(out.endsWith("\x1b[?2026l")).toBe(true);
  });

  test("an empty diff emits no sync guards either", () => {
    const buf = new CellBuffer(10, 1);
    buf.write(0, 0, "hi", {});
    capture(() => buf.flush());
    buf.clear();
    buf.write(0, 0, "hi", {});
    const out = capture(() => buf.flush());
    expect(out).toBe("");
  });

  test("invalidate() forces a full repaint — the Ctrl+L recovery path", () => {
    const buf = new CellBuffer(10, 1);
    buf.write(0, 0, "hi", {});
    capture(() => buf.flush());
    buf.invalidate();
    buf.clear();
    buf.write(0, 0, "hi", {});
    const out = capture(() => buf.flush());
    expect(out).toContain("hi");
  });

  test("a changed cell mid-row repaints only from that point, correctly positioned", () => {
    const buf = new CellBuffer(20, 1);
    buf.write(0, 0, "abcdef", {});
    capture(() => buf.flush());
    buf.clear();
    buf.write(0, 0, "abcXef", {});
    const out = capture(() => buf.flush());
    expect(out).toContain("\x1b[1;4H"); // col 3, where X goes
    expect(out).toContain("X");
    expect(out).not.toContain("abc"); // unchanged prefix not re-emitted
  });

  // ── Wide-pair breaking (the "stuck CJK fragments" corruption) ────────────
  // Terminals paint a wide glyph atomically: overwriting either column blanks
  // the other. If the back buffer keeps the untouched half, the diff believes
  // it is still on screen and skips it — the fragment sticks forever.

  test("overwriting a wide glyph's placeholder column repaints the glyph cell too", () => {
    const buf = new CellBuffer(20, 1);
    buf.write(0, 0, "中x", {}); // glyph at 0-1, x at 2
    capture(() => buf.flush());
    // A 1-column widget (e.g. a sidebar border) lands exactly on the
    // placeholder column. The glyph's left half is clobbered on screen.
    buf.set(0, 1, "|", {});
    const out = capture(() => buf.flush());
    // The glyph cell must NOT be believed still-visible: col 0 repaints
    // (as blank or new content) instead of being skipped.
    expect(out).toContain("\x1b[1;1H");
  });

  test("overwriting the glyph column blanks the orphaned placeholder", () => {
    const buf = new CellBuffer(20, 1);
    buf.write(0, 0, "中", {});
    capture(() => buf.flush());
    buf.set(0, 0, "A", {}); // pair broken from the left
    capture(() => buf.flush());
    // Back buffer must hold no orphaned wide placeholder at col 1.
    buf.clear();
    buf.write(0, 0, "AB", {});
    const out = capture(() => buf.flush());
    expect(out).toContain("B"); // col 1 paints normally — not skipped as a stale placeholder
  });

  test("a wide glyph written over another glyph's tail leaves no orphan placeholder", () => {
    const buf = new CellBuffer(20, 1);
    buf.write(0, 1, "中", {}); // glyph at 1-2
    capture(() => buf.flush());
    buf.clear();
    buf.write(0, 0, "文", {}); // new glyph at 0-1 — old pair broken mid-glyph
    capture(() => buf.flush());
    buf.clear();
    buf.write(0, 0, "文z", {}); // z at col 2, where the orphan would sit
    const out = capture(() => buf.flush());
    expect(out).toContain("z");
  });
});
