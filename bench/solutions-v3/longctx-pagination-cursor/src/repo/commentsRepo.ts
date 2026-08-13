/**
 * Repository for article comments.
 *
 * Listing order: `createdAt` ascending (oldest first), scoped to a single
 * article. Pagination follows the shared keyset convention via
 * `paginateAfter`: the cursor encodes the last delivered comment's
 * `createdAt`, and the next page starts strictly after it.
 */

import { Database } from "../db/database";
import { Query } from "../db/query";
import { TABLES, type Comment } from "../domain/models";
import type { Table } from "../db/table";
import { paginateAfter } from "./paginate";
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
   * The cursor encodes the last comment's createdAt; the next page starts
   * strictly after it.
   */
  listForArticle(articleId: string, options: ListOptions): Page<Comment> {
    const sorted = Query.from(this.table.all())
      .where((c) => c.articleId === articleId)
      .orderBy((c) => c.createdAt, "asc")
      .toArray();
    return paginateAfter(
      sorted,
      (c) => c.createdAt,
      options.cursor,
      options.limit,
    );
  }

  /** All comments by one author across articles, oldest first. */
  listByAuthor(authorId: string): Comment[] {
    return Query.from(this.table.all())
      .where((c) => c.authorId === authorId)
      .orderBy((c) => c.createdAt, "asc")
      .toArray();
  }
}
