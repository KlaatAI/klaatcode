/**
 * Repository for article comments.
 *
 * Listing order: `createdAt` ascending (oldest first), scoped to a single
 * article. Comment threads are the hottest listing in the product, so this
 * repository resumes pages directly from the previous page's end position
 * instead of re-deriving the boundary row on every fetch.
 */

import { Database } from "../db/database";
import { Query } from "../db/query";
import { TABLES, type Comment } from "../domain/models";
import type { Table } from "../db/table";
import { decodeCursor, encodeCursor } from "./cursor";
import type { ListOptions, Page } from "./types";

export class CommentsRepo {
  private readonly table: Table<Comment>;

  constructor(db: Database) {
    this.table = db.table<Comment>(TABLES.comments);
  }

  /** Inserts a new comment. */
  create(comment: Comment): Comment {
    return this.table.insert(comment);
  }

  /** Deletes a comment by id. */
  delete(id: string): void {
    this.table.remove(id);
  }

  /** Point lookup. */
  findById(id: string): Comment | undefined {
    return this.table.get(id);
  }

  /** Number of comments on one article. */
  countForArticle(articleId: string): number {
    return Query.from(this.table.all())
      .where((c) => c.articleId === articleId)
      .count();
  }

  /**
   * One page of comments for an article, ordered by createdAt ascending.
   * The returned cursor resumes the walk where this page left off.
   */
  listForArticle(articleId: string, options: ListOptions): Page<Comment> {
    const sorted = Query.from(this.table.all())
      .where((c) => c.articleId === articleId)
      .orderBy((c) => c.createdAt, "asc")
      .toArray();

    // Resume from the position immediately after the rows already served.
    // The previous page recorded how far into the thread it got, so we can
    // jump straight there without scanning for the boundary row again.
    let start = 0;
    if (options.cursor != null) {
      const payload = decodeCursor(options.cursor);
      start = Number(payload.key);
    }

    const items = sorted.slice(start, start + options.limit);

    const served = start + items.length;
    const nextCursor = served < sorted.length ? encodeCursor(served) : null;

    return { items, nextCursor };
  }

  /** All comments by one author across articles, oldest first. */
  listByAuthor(authorId: string): Comment[] {
    return Query.from(this.table.all())
      .where((c) => c.authorId === authorId)
      .orderBy((c) => c.createdAt, "asc")
      .toArray();
  }
}
