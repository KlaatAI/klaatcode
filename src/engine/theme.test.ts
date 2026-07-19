import { describe, expect, test } from "bun:test";
import {
  THEME_DESCRIPTIONS,
  THEME_NAMES,
  TOKYO_NIGHT_PALETTE,
  getPalette,
} from "./theme.js";

describe("Tokyo Night theme", () => {
  test("is registered with its description and palette", () => {
    expect(THEME_NAMES).toContain("tokyo-night");
    expect(THEME_DESCRIPTIONS["tokyo-night"]).toContain("Tokyo Night");
    expect(getPalette("tokyo-night")).toBe(TOKYO_NIGHT_PALETTE);
  });

  test("uses valid 256-color slots", () => {
    const numericSlots = Object.values(TOKYO_NIGHT_PALETTE)
      .filter((value): value is number => typeof value === "number");

    expect(numericSlots.length).toBeGreaterThan(0);
    for (const color of numericSlots) {
      expect(Number.isInteger(color)).toBe(true);
      expect(color).toBeGreaterThanOrEqual(0);
      expect(color).toBeLessThanOrEqual(255);
    }
  });

  test("uses supported hex colors and the terminal background", () => {
    const hexSlots = [
      TOKYO_NIGHT_PALETTE.accent,
      TOKYO_NIGHT_PALETTE.dimText,
      TOKYO_NIGHT_PALETTE.userColor,
      TOKYO_NIGHT_PALETTE.border,
      TOKYO_NIGHT_PALETTE.thumb,
    ];

    for (const color of hexSlots) {
      expect(color).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(TOKYO_NIGHT_PALETTE.bg).toBeNull();
  });
});
