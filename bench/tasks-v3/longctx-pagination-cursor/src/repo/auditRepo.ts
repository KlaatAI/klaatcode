/**
 * Repository for the append-only audit log.
 *
 * Listing order: `at` ascending (chronological). Pagination follows the
 * shared keyset convention via `paginateAfter`. Although the log is
 * append-only in production, retention jobs may delete old entries while a
 * reader is mid-walk, so cursor stability still matters here.
 */

import { Database } from "../db/database";
import { Query } from "../db/query";
import { TABLES, type AuditAction, type AuditEntry } from "../domain/models";
import type { Table } from "../db/table";
import { paginateAfter } from "./paginate";
import type { ListOptions, Page } from "./types";

export class AuditRepo {
  private readonly table: Table<AuditEntry>;

  constructor(db: Database) {
    this.table = db.table<AuditEntry>(TABLES.audit);
  }

  /** Appends a new entry. */
  append(entry: AuditEntry): AuditEntry {
    return this.table.insert(entry);
  }

  /** Retention hook: drops one entry by id. */
  purge(id: string): void {
    this.table.remove(id);
  }

  /** Point lookup. */
  findById(id: string): AuditEntry | undefined {
    return this.table.get(id);
  }

  /** Number of stored entries. */
  count(): number {
    return this.table.count();
  }

  /**
   * One page of audit entries in chronological order. The cursor encodes
   * the last entry's `at`; the next page starts strictly after it.
   */
  list(options: ListOptions): Page<AuditEntry> {
    const sorted = Query.from(this.table.all())
      .orderBy((e) => e.at, "asc")
      .toArray();
    return paginateAfter(sorted, (e) => e.at, options.cursor, options.limit);
  }

  /** Entries for one action type, same ordering and cursor semantics. */
  listByAction(action: AuditAction, options: ListOptions): Page<AuditEntry> {
    const sorted = Query.from(this.table.all())
      .where((e) => e.action === action)
      .orderBy((e) => e.at, "asc")
      .toArray();
    return paginateAfter(sorted, (e) => e.at, options.cursor, options.limit);
  }
}
