import { test, expect } from "bun:test";
import { normalize, union, intersect, subtract, freeSlots, type Iv } from "./intervals";

test("normalize merges touching intervals", () => {
  expect(normalize([[1, 2], [2, 3]])).toEqual([[1, 3]]);
});

test("normalize merges overlapping and contained intervals", () => {
  expect(normalize([[1, 5], [2, 3], [4, 8]])).toEqual([[1, 8]]);
});

test("normalize sorts unsorted messy input", () => {
  expect(normalize([[10, 12], [-5, -1], [0, 4], [3, 6]])).toEqual([[-5, -1], [0, 6], [10, 12]]);
});

test("normalize drops empty and inverted intervals", () => {
  expect(normalize([[3, 3], [7, 2], [1, 2]])).toEqual([[1, 2]]);
  expect(normalize([])).toEqual([]);
});

test("union of disjoint sets keeps them apart, bridging intervals merge", () => {
  expect(union([[0, 1], [5, 6]], [[2, 3]])).toEqual([[0, 1], [2, 3], [5, 6]]);
  expect(union([[0, 2], [4, 6]], [[2, 4]])).toEqual([[0, 6]]);
});

test("intersect basic overlaps", () => {
  expect(intersect([[0, 5]], [[3, 8]])).toEqual([[3, 5]]);
  expect(intersect([[0, 10]], [[1, 2], [3, 4], [9, 12]])).toEqual([[1, 2], [3, 4], [9, 10]]);
});

test("intersect of touching intervals is empty", () => {
  expect(intersect([[0, 2]], [[2, 4]])).toEqual([]);
});

test("intersect with unnormalized inputs", () => {
  expect(intersect([[5, 1], [0, 4], [3, 6]], [[2, 2], [2, 5]])).toEqual([[2, 5]]);
});

test("subtract splits an interval around a hole", () => {
  expect(subtract([[0, 10]], [[3, 5]])).toEqual([[0, 3], [5, 10]]);
});

test("subtract with multiple holes", () => {
  expect(subtract([[0, 10]], [[1, 2], [4, 6], [9, 20]])).toEqual([[0, 1], [2, 4], [6, 9]]);
});

test("subtract removing everything yields empty", () => {
  expect(subtract([[2, 4], [6, 8]], [[0, 10]])).toEqual([]);
});

test("subtract with nothing overlapping (touching does not remove)", () => {
  expect(subtract([[0, 2]], [[2, 5], [-3, 0]])).toEqual([[0, 2]]);
});

test("subtract shaving both edges", () => {
  expect(subtract([[0, 10]], [[-2, 3], [8, 12]])).toEqual([[3, 8]]);
});

test("freeSlots computes gaps within bounds", () => {
  expect(freeSlots([[9, 10], [12, 13]], [8, 17])).toEqual([[8, 9], [10, 12], [13, 17]]);
});

test("freeSlots clips busy outside bounds and handles edge cases", () => {
  expect(freeSlots([[0, 9], [16, 24]], [9, 16])).toEqual([[9, 16]]);
  expect(freeSlots([], [1, 2])).toEqual([[1, 2]]);
  expect(freeSlots([[0, 24]], [9, 17])).toEqual([]);
});

test("float endpoints work", () => {
  expect(normalize([[0.5, 1.25], [1.25, 2.5]])).toEqual([[0.5, 2.5]]);
});

test("inputs are never mutated and outputs are fresh", () => {
  const a: Iv[] = [[4, 6], [1, 3]];
  const b: Iv[] = [[2, 5]];
  const aSnap = JSON.stringify(a);
  const bSnap = JSON.stringify(b);

  const u = union(a, b);
  const x = intersect(a, b);
  const s = subtract(a, b);
  const n = normalize(a);
  const bounds: Iv = [0, 10];
  const f = freeSlots(a, bounds);

  expect(JSON.stringify(a)).toBe(aSnap);
  expect(JSON.stringify(b)).toBe(bSnap);
  expect(bounds).toEqual([0, 10]);
  expect(n).not.toBe(a);

  const inputTuples = new Set<Iv>([...a, ...b, bounds]);
  for (const arr of [u, x, s, n, f]) {
    for (const iv of arr) {
      expect(inputTuples.has(iv)).toBe(false);
    }
  }
});
