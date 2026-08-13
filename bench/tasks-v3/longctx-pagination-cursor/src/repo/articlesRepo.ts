/**
 * Repository for published articles.
 *
 * Listing order: `publishedAt` ascending (oldest first). Pagination follows
 * the shared keyset convention via `paginateAfter`.
 */

import { Database } from "../db/database";
import { Query } from "../db/query";
import { TABLES, type Article } from "../domain/models";
import type { Table } from "../db/table";
import { paginateAfter } from "./paginate";
import type { ListOptions, Page } from "./types";

export class ArticlesRepo {
  private readonly table: Table<Article>;

  constructor(db: Database) {
    this.table = db.table<Article>(TABLES.articles);
  }

  /** Inserts a new article. */
  create(article: Article): Article {
    return this.table.insert(article);
  }

  /** Deletes an article by id. */
  delete(id: string): void {
    this.table.remove(id);
  }

  /** Point lookup. */
  findById(id: string): Article | undefined {
    return this.table.get(id);
  }

  /** Lookup by slug; slugs are unique in practice but not enforced here. */
  findBySlug(slug: string): Article | undefined {
    return Query.from(this.table.all())
      .where((a) => a.slug === slug)
      .first();
  }

  /** Number of stored articles. */
  count(): number {
    return this.table.count();
  }

  /**
   * One page of articles ordered by publishedAt ascending. The cursor
   * encodes the last article's publishedAt; the next page starts strictly
   * after it.
   */
  list(options: ListOptions): Page<Article> {
    const sorted = Query.from(this.table.all())
      .orderBy((a) => a.publishedAt, "asc")
      .toArray();
    return paginateAfter(sorted, (a) => a.publishedAt, options.cursor, options.limit);
  }

  /** Articles by a given author, same ordering and cursor semantics. */
  listByAuthor(authorId: string, options: ListOptions): Page<Article> {
    const sorted = Query.from(this.table.all())
      .where((a) => a.authorId === authorId)
      .orderBy((a) => a.publishedAt, "asc")
      .toArray();
    return paginateAfter(sorted, (a) => a.publishedAt, options.cursor, options.limit);
  }
}
