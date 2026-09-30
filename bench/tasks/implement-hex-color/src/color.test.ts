import { expect, test } from "bun:test";
import { parseHexColor } from "./color.js";

test("parses 6-digit hex with hash", () => {
  expect(parseHexColor("#336699")).toEqual({ r: 51, g: 102, b: 153, a: 1 });
});

test("parses 6-digit hex without hash and case-insensitive", () => {
  expect(parseHexColor("ff8800")).toEqual({ r: 255, g: 136, b: 0, a: 1 });
  expect(parseHexColor("AABBCC")).toEqual({ r: 170, g: 187, b: 204, a: 1 });
});

test("parses 3-digit shorthand hex", () => {
  expect(parseHexColor("#f00")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  expect(parseHexColor("0F0")).toEqual({ r: 0, g: 255, b: 0, a: 1 });
});

test("parses 4-digit shorthand hex with alpha", () => {
  expect(parseHexColor("#f008")).toEqual({ r: 255, g: 0, b: 0, a: 0.533 });
  expect(parseHexColor("000f")).toEqual({ r: 0, g: 0, b: 0, a: 1 });
});

test("parses 8-digit hex with alpha", () => {
  expect(parseHexColor("#33669980")).toEqual({ r: 51, g: 102, b: 153, a: 0.502 });
  expect(parseHexColor("00000000")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
});

test("returns null for invalid inputs", () => {
  expect(parseHexColor("")).toBeNull();
  expect(parseHexColor("#")).toBeNull();
  expect(parseHexColor("#12")).toBeNull();
  expect(parseHexColor("#12345")).toBeNull();
  expect(parseHexColor("#123456789")).toBeNull();
  expect(parseHexColor("#xyz")).toBeNull();
  expect(parseHexColor("#123g")).toBeNull();
});
