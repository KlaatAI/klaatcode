import { test, expect } from "bun:test";
import { truncateDisplay } from "./truncate";

test("returns short strings unchanged", () => {
  expect(truncateDisplay("hello", 10)).toBe("hello");
  expect(truncateDisplay("hello", 5)).toBe("hello");
  expect(truncateDisplay("", 3)).toBe("");
});

test("truncates plain ASCII and appends the ellipsis", () => {
  expect(truncateDisplay("hello world", 5)).toBe("hello…");
  expect(truncateDisplay("abcdef", 2, "...")).toBe("ab...");
});

test("surrogate-pair emoji count as one character each", () => {
  expect(truncateDisplay("😀😁😂", 2)).toBe("😀😁…");
  expect(truncateDisplay("😀😁", 2)).toBe("😀😁");
});

test("ZWJ family sequences are never split", () => {
  expect(truncateDisplay("👩‍👩‍👧‍👦", 1)).toBe("👩‍👩‍👧‍👦");
  expect(truncateDisplay("👩‍👩‍👧‍👦!", 1)).toBe("👩‍👩‍👧‍👦…");
  expect(truncateDisplay("x👩‍👩‍👧‍👦y", 2)).toBe("x👩‍👩‍👧‍👦…");
});

test("regional-indicator flags stay whole", () => {
  expect(truncateDisplay("🇮🇳🇯🇵", 1)).toBe("🇮🇳…");
  expect(truncateDisplay("🇮🇳🇯🇵", 2)).toBe("🇮🇳🇯🇵");
});

test("combining marks stay attached to their base character", () => {
  const e1 = "é"; // é as base letter + combining acute
  expect(truncateDisplay(e1 + e1 + e1, 2)).toBe(e1 + e1 + "…");
  expect(truncateDisplay("caf" + e1, 4)).toBe("caf" + e1);
});

test("skin-tone modifiers stay attached", () => {
  expect(truncateDisplay("👍🏽ok", 1)).toBe("👍🏽…");
  expect(truncateDisplay("👍🏽", 1)).toBe("👍🏽");
});

test("maxGraphemes of zero yields just the ellipsis for non-empty input", () => {
  expect(truncateDisplay("abc", 0)).toBe("…");
  expect(truncateDisplay("", 0)).toBe("");
});

test("custom ellipsis works with complex graphemes", () => {
  expect(truncateDisplay("🇮🇳👩‍👩‍👧‍👦z", 2, " [more]")).toBe("🇮🇳👩‍👩‍👧‍👦 [more]");
});
