/**
 * Interval set operations over closed-open numeric intervals.
 *
 * An interval `Iv = [start, end)` contains every number x with
 * start <= x < end. Endpoints may be any finite numbers (negative, float).
 * An interval with start >= end is EMPTY and must be dropped.
 *
 * A "normalized" interval array is:
 *   - sorted ascending by start,
 *   - pairwise disjoint AND non-touching (touching intervals like [1,2) and
 *     [2,3) are merged into [1,3) because together they cover [1,3) with no
 *     gap),
 *   - free of empty intervals.
 *
 * Functions (ALL of them):
 *   - accept arbitrary input: unsorted, overlapping, touching, empty and
 *     inverted (start >= end) intervals may appear in any argument,
 *   - return a normalized array,
 *   - NEVER mutate their inputs, and never return references to the input
 *     arrays or to the input `[start, end]` tuples — outputs are freshly
 *     allocated.
 *
 * normalize(ivs): the normalized form of the set covered by `ivs`.
 * union(a, b): normalized set of points covered by `a` or `b` (or both).
 * intersect(a, b): normalized set of points covered by both `a` and `b`.
 *   Note that touching intervals share no point: [0,2) ∩ [2,4) = [].
 * subtract(a, b): normalized set of points covered by `a` but not by `b`.
 *   A hole strictly inside an interval splits it:
 *   subtract([[0,10]], [[3,5]]) = [[0,3],[5,10]].
 * freeSlots(busy, bounds): the gaps inside `bounds` not covered by `busy`,
 *   i.e. exactly subtract([bounds], busy). Busy time outside `bounds` is
 *   irrelevant. With no busy intervals the answer is [bounds] (as a fresh
 *   tuple).
 */
export type Iv = [number, number];

export function normalize(ivs: Iv[]): Iv[] {
  throw new Error("not implemented");
}

export function union(a: Iv[], b: Iv[]): Iv[] {
  throw new Error("not implemented");
}

export function intersect(a: Iv[], b: Iv[]): Iv[] {
  throw new Error("not implemented");
}

export function subtract(a: Iv[], b: Iv[]): Iv[] {
  throw new Error("not implemented");
}

export function freeSlots(busy: Iv[], bounds: Iv): Iv[] {
  throw new Error("not implemented");
}
