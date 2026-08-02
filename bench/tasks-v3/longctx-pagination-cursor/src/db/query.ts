/**
 * Minimal fluent query builder over row snapshots.
 *
 * Every operation returns a new `Query`; the underlying array is never
 * mutated. The builder is deliberately eager and simple — repositories use
 * it for filtering and for the *stable* sort that cursor pagination relies
 * on. Stability matters: when two rows share a sort key the original
 * relative order is preserved, so tie-breaking by id stays deterministic.
 */

export type SortDirection = "asc" | "desc";

export type Selector<T> = (row: T) => number | string;

function compareValues(a: number | string, b: number | string): number {
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }
  const sa = String(a);
  const sb = String(b);
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

export class Query<T> {
  private constructor(private readonly rows: readonly T[]) {}

  static from<T>(rows: readonly T[]): Query<T> {
    return new Query(rows);
  }

  /** Keeps only rows for which the predicate returns true. */
  where(predicate: (row: T) => boolean): Query<T> {
    return new Query(this.rows.filter(predicate));
  }

  /**
   * Stable sort by the selected key. JavaScript's Array#sort is stable per
   * spec, but we make stability explicit by decorating with the original
   * index and using it as the final tie-break.
   */
  orderBy(selector: Selector<T>, direction: SortDirection = "asc"): Query<T> {
    const decorated = this.rows.map((row, index) => ({ row, index }));
    decorated.sort((x, y) => {
      const primary = compareValues(selector(x.row), selector(y.row));
      const oriented = direction === "asc" ? primary : -primary;
      if (oriented !== 0) return oriented;
      return x.index - y.index;
    });
    return new Query(decorated.map((d) => d.row));
  }

  /** Keeps at most the first `n` rows. */
  take(n: number): Query<T> {
    if (!Number.isInteger(n) || n < 0) {
      throw new RangeError(`take() requires a non-negative integer, got ${n}`);
    }
    return new Query(this.rows.slice(0, n));
  }

  /** Skips the first `n` rows. */
  skip(n: number): Query<T> {
    if (!Number.isInteger(n) || n < 0) {
      throw new RangeError(`skip() requires a non-negative integer, got ${n}`);
    }
    return new Query(this.rows.slice(n));
  }

  /** Number of rows currently selected. */
  count(): number {
    return this.rows.length;
  }

  /** First row, or undefined when the selection is empty. */
  first(): T | undefined {
    return this.rows[0];
  }

  /** Last row, or undefined when the selection is empty. */
  last(): T | undefined {
    return this.rows[this.rows.length - 1];
  }

  /** Materializes the selection as a fresh mutable array. */
  toArray(): T[] {
    return [...this.rows];
  }
}
