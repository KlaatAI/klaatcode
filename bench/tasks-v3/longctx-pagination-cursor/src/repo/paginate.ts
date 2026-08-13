/**
 * Shared keyset ("seek") pagination helper.
 *
 * Implements the codebase-wide convention documented in domain/models.ts:
 * the cursor encodes the sort key of the last delivered row, and the next
 * page starts strictly after that key. Because the resume point is a key —
 * not an index — rows inserted or deleted between page fetches can shift
 * positions freely without making a walker skip or repeat anything.
 */

import { decodeCursor, encodeCursor } from "./cursor";
import type { Page } from "./types";

/**
 * Slices one page out of `sortedRows`.
 *
 * @param sortedRows rows already sorted ascending by `keyOf`
 * @param keyOf      extracts the sort key the rows are ordered by
 * @param cursor     opaque cursor from the previous page, or null/undefined
 * @param limit      maximum rows to return (already validated upstream)
 */
export function paginateAfter<T>(
  sortedRows: readonly T[],
  keyOf: (row: T) => number | string,
  cursor: string | null | undefined,
  limit: number,
): Page<T> {
  let startIndex = 0;
  if (cursor != null) {
    const payload = decodeCursor(cursor);
    // Binary search for the first row whose key is strictly greater than
    // the cursor key. Linear scan would be correct too; this keeps large
    // tables cheap and, more importantly, documents the "strictly after"
    // contract in executable form.
    startIndex = lowerBoundStrictlyAfter(sortedRows, keyOf, payload.key);
  }

  const items = sortedRows.slice(startIndex, startIndex + limit).map((r) => r);

  const isLastPage = startIndex + items.length >= sortedRows.length;
  const lastItem = items.length > 0 ? items[items.length - 1]! : null;
  const nextCursor =
    !isLastPage && lastItem !== null ? encodeCursor(keyOf(lastItem)) : null;

  return { items, nextCursor };
}

/**
 * Index of the first row whose key compares strictly greater than `key` in
 * an ascending-sorted array. Returns `rows.length` when no such row exists.
 */
export function lowerBoundStrictlyAfter<T>(
  rows: readonly T[],
  keyOf: (row: T) => number | string,
  key: number | string,
): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareKeys(keyOf(rows[mid]!), key) <= 0) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function compareKeys(a: number | string, b: number | string): number {
  if (typeof a === "number" && typeof b === "number") {
    return a === b ? 0 : a < b ? -1 : 1;
  }
  const sa = String(a);
  const sb = String(b);
  return sa === sb ? 0 : sa < sb ? -1 : 1;
}
