/**
 * A single in-memory table.
 *
 * Rows are stored in a Map keyed by `id`, so lookups and deletes are O(1).
 * Iteration order of `all()` is insertion order — repositories must sort
 * explicitly and never rely on Map ordering (the query builder exists for
 * exactly that reason).
 */

export interface Row {
  readonly id: string;
}

export class DuplicateIdError extends Error {
  constructor(table: string, id: string) {
    super(`table "${table}": duplicate id "${id}"`);
    this.name = "DuplicateIdError";
  }
}

export class MissingRowError extends Error {
  constructor(table: string, id: string) {
    super(`table "${table}": no row with id "${id}"`);
    this.name = "MissingRowError";
  }
}

export class Table<T extends Row> {
  private readonly rows = new Map<string, T>();

  constructor(readonly name: string) {}

  /** Inserts a new row. Throws if the id is already taken. */
  insert(row: T): T {
    if (this.rows.has(row.id)) {
      throw new DuplicateIdError(this.name, row.id);
    }
    this.rows.set(row.id, { ...row });
    return row;
  }

  /** Replaces an existing row wholesale. Throws if it does not exist. */
  replace(row: T): T {
    if (!this.rows.has(row.id)) {
      throw new MissingRowError(this.name, row.id);
    }
    this.rows.set(row.id, { ...row });
    return row;
  }

  /** Removes a row by id. Throws if it does not exist. */
  remove(id: string): void {
    if (!this.rows.delete(id)) {
      throw new MissingRowError(this.name, id);
    }
  }

  /** Returns the row or undefined. The returned object is a defensive copy. */
  get(id: string): T | undefined {
    const row = this.rows.get(id);
    return row ? { ...row } : undefined;
  }

  /** Returns the row or throws. */
  getOrThrow(id: string): T {
    const row = this.get(id);
    if (!row) {
      throw new MissingRowError(this.name, id);
    }
    return row;
  }

  /** True if a row with this id exists. */
  has(id: string): boolean {
    return this.rows.has(id);
  }

  /**
   * Snapshot of every row, as defensive copies, in insertion order.
   * Callers that need a particular order must sort the result themselves.
   */
  all(): T[] {
    return [...this.rows.values()].map((r) => ({ ...r }));
  }

  /** Number of rows currently stored. */
  count(): number {
    return this.rows.size;
  }

  /** Removes every row. */
  clear(): void {
    this.rows.clear();
  }
}
