/**
 * In-memory database used by the repository layer.
 *
 * The database is a thin registry of named tables. Repositories obtain a
 * typed `Table` handle once at construction time and never reach into the
 * registry again. All state lives inside the `Table` instances, so creating
 * a fresh `Database` per test gives full isolation.
 */

import { Table, type Row } from "./table";

export class Database {
  private readonly tables = new Map<string, Table<Row>>();

  /**
   * Returns the table registered under `name`, creating it on first access.
   * The type parameter is a promise made by the caller; the database itself
   * stores rows untyped.
   */
  table<T extends Row>(name: string): Table<T> {
    let existing = this.tables.get(name);
    if (!existing) {
      existing = new Table<Row>(name);
      this.tables.set(name, existing);
    }
    return existing as unknown as Table<T>;
  }

  /** True if a table with this name has been created. */
  hasTable(name: string): boolean {
    return this.tables.has(name);
  }

  /** Names of every table that has been touched, in creation order. */
  tableNames(): string[] {
    return [...this.tables.keys()];
  }

  /** Total row count across all tables. Used by diagnostics only. */
  totalRows(): number {
    let n = 0;
    for (const t of this.tables.values()) {
      n += t.count();
    }
    return n;
  }

  /** Drops every row in every table but keeps the table registrations. */
  clearAll(): void {
    for (const t of this.tables.values()) {
      t.clear();
    }
  }
}

/** Convenience factory so call sites read `createDatabase()` rather than `new`. */
export function createDatabase(): Database {
  return new Database();
}
