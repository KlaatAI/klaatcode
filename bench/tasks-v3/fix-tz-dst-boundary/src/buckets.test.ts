import { test, expect } from "bun:test";
import { dailyBuckets } from "./buckets";

const T = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0) =>
  Date.UTC(y, mo - 1, d, h, mi, s, ms);

function keyOf(ts: number, offset: number): string {
  const m = dailyBuckets([ts], offset);
  expect(m.size).toBe(1);
  return [...m.keys()][0]!;
}

test("offset 0 buckets by plain UTC date", () => {
  expect(keyOf(T(2024, 1, 15, 12, 0), 0)).toBe("2024-01-15");
  expect(keyOf(T(2024, 1, 15, 0, 0), 0)).toBe("2024-01-15");
  expect(keyOf(T(2024, 1, 14, 23, 59, 59, 999), 0)).toBe("2024-01-14");
});

test("positive offset: early-UTC-morning events belong to the same local day", () => {
  // 00:30 UTC is 06:00 in India (+5:30) — still Jan 15 locally.
  expect(keyOf(T(2024, 1, 15, 0, 30), 330)).toBe("2024-01-15");
});

test("positive offset: local midnight boundary is exact", () => {
  // 18:30 UTC on Jan 14 is exactly 00:00 Jan 15 in India.
  expect(keyOf(T(2024, 1, 14, 18, 30), 330)).toBe("2024-01-15");
  // One millisecond earlier is still Jan 14 locally.
  expect(keyOf(T(2024, 1, 14, 18, 29, 59, 999), 330)).toBe("2024-01-14");
});

test("negative offset: late-UTC-evening events stay on the same local day", () => {
  // 23:30 UTC is 18:30 in New York (-5:00) — still Jan 15 locally.
  expect(keyOf(T(2024, 1, 15, 23, 30), -300)).toBe("2024-01-15");
});

test("negative offset: local midnight boundary is exact", () => {
  // 04:59 UTC Jan 16 is 23:59 Jan 15 in New York.
  expect(keyOf(T(2024, 1, 16, 4, 59), -300)).toBe("2024-01-15");
  // 05:00 UTC Jan 16 is exactly 00:00 Jan 16 in New York.
  expect(keyOf(T(2024, 1, 16, 5, 0), -300)).toBe("2024-01-16");
});

test("half-hour negative offset (Marquesas, -9:30)", () => {
  expect(keyOf(T(2024, 3, 10, 9, 29), -570)).toBe("2024-03-09");
  expect(keyOf(T(2024, 3, 10, 9, 30), -570)).toBe("2024-03-10");
});

test("groups a mixed batch around a boundary correctly", () => {
  const a = T(2024, 5, 1, 17, 0); // IST 22:30 May 1
  const b = T(2024, 5, 1, 18, 29); // IST 23:59 May 1
  const c = T(2024, 5, 1, 18, 30); // IST 00:00 May 2
  const d = T(2024, 5, 2, 3, 0); // IST 08:30 May 2
  const m = dailyBuckets([d, b, c, a], 330);
  expect(m.size).toBe(2);
  expect(m.get("2024-05-01")).toEqual([a, b]);
  expect(m.get("2024-05-02")).toEqual([c, d]);
});

test("month and year boundaries roll over in local time", () => {
  // 19:00 UTC Dec 31 is 00:30 Jan 1 in India.
  expect(keyOf(T(2023, 12, 31, 19, 0), 330)).toBe("2024-01-01");
  // 02:00 UTC Mar 1 is 21:00 Feb 29 in New York (leap year).
  expect(keyOf(T(2024, 3, 1, 2, 0), -300)).toBe("2024-02-29");
});

test("empty input yields an empty map", () => {
  expect(dailyBuckets([], 330).size).toBe(0);
});
