/**
 * Domain model shared across repositories and the listing service.
 *
 * Timestamps are epoch milliseconds everywhere (see util/clock.ts).
 *
 * Pagination convention (applies to every listing in this codebase):
 *   - Listings are ordered by a single monotone sort key per entity
 *     (articles: `publishedAt`; comments: `createdAt`; audit: `at`).
 *   - A page's `nextCursor` is an opaque token that encodes the SORT KEY of
 *     the last item on the page. The next page contains rows whose sort key
 *     is STRICTLY GREATER than the cursor's key.
 *   - Because the cursor names a key rather than a position, concurrent
 *     inserts and deletes must never cause a walker to see a row twice or
 *     to skip a row it had not yet reached.
 */

export interface Article {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly authorId: string;
  /** Sort key for article listings. Unique per article in this system. */
  readonly publishedAt: number;
}

export interface Comment {
  readonly id: string;
  readonly articleId: string;
  readonly authorId: string;
  readonly body: string;
  /** Sort key for comment listings. Unique per comment in this system. */
  readonly createdAt: number;
}

export type AuditAction =
  | "article.publish"
  | "article.unpublish"
  | "comment.create"
  | "comment.delete"
  | "user.login";

export interface AuditEntry {
  readonly id: string;
  readonly actorId: string;
  readonly action: AuditAction;
  readonly subjectId: string;
  /** Sort key for audit listings. Unique per entry in this system. */
  readonly at: number;
}

/** Table names, centralized so repositories and seeds cannot drift. */
export const TABLES = {
  articles: "articles",
  comments: "comments",
  audit: "audit_log",
} as const;
