import { test, expect } from "bun:test";
import { nextRun } from "./cron";

const at = (s: string) => new Date(s);
const iso = (d: Date) => d.toISOString();

test("top-of-hour rollover", () => {
  expect(iso(nextRun("0 * * * *", at("2026-01-15T10:05:30Z")))).toBe("2026-01-15T11:00:00.000Z");
  expect(iso(nextRun("0 * * * *", at("2026-01-15T10:59:59Z")))).toBe("2026-01-15T11:00:00.000Z");
});

test("step minutes */15 and strictly-after semantics", () => {
  expect(iso(nextRun("*/15 * * * *", at("2026-01-15T10:07:00Z")))).toBe("2026-01-15T10:15:00.000Z");
  // after lies exactly on a match: must return the NEXT one
  expect(iso(nextRun("*/15 * * * *", at("2026-01-15T10:15:00Z")))).toBe("2026-01-15T10:30:00.000Z");
  expect(iso(nextRun("*/15 * * * *", at("2026-01-15T23:46:00Z")))).toBe("2026-01-16T00:00:00.000Z");
});

test("fixed daily time", () => {
  expect(iso(nextRun("30 14 * * *", at("2026-01-15T15:00:00Z")))).toBe("2026-01-16T14:30:00.000Z");
  expect(iso(nextRun("30 14 * * *", at("2026-01-15T14:29:59Z")))).toBe("2026-01-15T14:30:00.000Z");
});

test("month and year rollover", () => {
  expect(iso(nextRun("0 0 1 * *", at("2026-01-31T12:00:00Z")))).toBe("2026-02-01T00:00:00.000Z");
  expect(iso(nextRun("0 0 1 1 *", at("2026-06-01T00:00:00Z")))).toBe("2027-01-01T00:00:00.000Z");
  expect(iso(nextRun("0 0 1 3,6 *", at("2026-04-01T00:00:00Z")))).toBe("2026-06-01T00:00:00.000Z");
});

test("Feb 29 only exists in leap years", () => {
  expect(iso(nextRun("0 0 29 2 *", at("2025-03-01T00:00:00Z")))).toBe("2028-02-29T00:00:00.000Z");
  expect(iso(nextRun("0 0 29 2 *", at("2028-02-28T00:00:00Z")))).toBe("2028-02-29T00:00:00.000Z");
});

test("day-of-week matching (0 = Sunday)", () => {
  // 2026-01-09 is a Friday; next Monday is 2026-01-12
  expect(iso(nextRun("0 9 * * 1", at("2026-01-09T10:00:00Z")))).toBe("2026-01-12T09:00:00.000Z");
  // same day later hour still qualifies
  expect(iso(nextRun("0 9 * * 5", at("2026-01-09T08:00:00Z")))).toBe("2026-01-09T09:00:00.000Z");
  // 2026-01-11 is a Sunday
  expect(iso(nextRun("0 12 * * 0", at("2026-01-05T00:00:00Z")))).toBe("2026-01-11T12:00:00.000Z");
});

test("dom/dow OR-semantics when both are restricted", () => {
  // "the 13th OR any Friday". Fridays in Jan 2026: 2, 9, 16, 23, 30.
  expect(iso(nextRun("0 0 13 * 5", at("2026-01-03T00:00:00Z")))).toBe("2026-01-09T00:00:00.000Z");
  expect(iso(nextRun("0 0 13 * 5", at("2026-01-09T00:00:00Z")))).toBe("2026-01-13T00:00:00.000Z");
  expect(iso(nextRun("0 0 13 * 5", at("2026-01-13T00:00:00Z")))).toBe("2026-01-16T00:00:00.000Z");
});

test("dom alone is ANDed like any other field", () => {
  expect(iso(nextRun("0 0 13 * *", at("2026-01-13T00:00:00Z")))).toBe("2026-02-13T00:00:00.000Z");
});

test("lists, ranges, stepped ranges", () => {
  expect(iso(nextRun("5,35 14 * * *", at("2026-03-10T14:10:00Z")))).toBe("2026-03-10T14:35:00.000Z");
  expect(iso(nextRun("0 9-17 * * *", at("2026-03-10T18:30:00Z")))).toBe("2026-03-11T09:00:00.000Z");
  expect(iso(nextRun("10-30/5 * * * *", at("2026-03-10T10:22:00Z")))).toBe("2026-03-10T10:25:00.000Z");
  expect(iso(nextRun("10-30/5 * * * *", at("2026-03-10T10:31:00Z")))).toBe("2026-03-10T11:10:00.000Z");
});

test("invalid expressions throw", () => {
  expect(() => nextRun("* * * *", at("2026-01-01T00:00:00Z"))).toThrow();
  expect(() => nextRun("60 * * * *", at("2026-01-01T00:00:00Z"))).toThrow();
});
