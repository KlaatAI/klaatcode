/**
 * Deterministic seed data.
 *
 * The fixture is intentionally boring: evenly spaced sort keys, zero-padded
 * ids, one article that carries all the seeded comments. Tests rely on the
 * exact ids and timestamps below.
 */

import { Database } from "../db/database";
import {
  TABLES,
  type Article,
  type AuditEntry,
  type Comment,
} from "./models";

export const SEED_ARTICLE_COUNT = 12;
export const SEED_COMMENT_COUNT = 15;
export const SEED_AUDIT_COUNT = 12;

/** Article a01 publishes at 100_000; each subsequent article +10_000. */
export const ARTICLE_EPOCH = 100_000;
export const ARTICLE_SPACING = 10_000;

/** Comment c01 is created at 1_000; each subsequent comment +1_000. */
export const COMMENT_EPOCH = 1_000;
export const COMMENT_SPACING = 1_000;

/** Audit entry e01 happens at 5_000; each subsequent entry +5_000. */
export const AUDIT_EPOCH = 5_000;
export const AUDIT_SPACING = 5_000;

/** The article that owns every seeded comment. */
export const SEED_COMMENTED_ARTICLE = "a01";

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function articleId(n: number): string {
  return `a${pad2(n)}`;
}

export function commentId(n: number): string {
  return `c${pad2(n)}`;
}

export function auditId(n: number): string {
  return `e${pad2(n)}`;
}

export function seedDatabase(db: Database): void {
  const articles = db.table<Article>(TABLES.articles);
  const comments = db.table<Comment>(TABLES.comments);
  const audit = db.table<AuditEntry>(TABLES.audit);

  for (let n = 1; n <= SEED_ARTICLE_COUNT; n++) {
    articles.insert({
      id: articleId(n),
      slug: `seeded-article-${pad2(n)}`,
      title: `Seeded article #${n}`,
      authorId: n % 2 === 0 ? "author-even" : "author-odd",
      publishedAt: ARTICLE_EPOCH + (n - 1) * ARTICLE_SPACING,
    });
  }

  for (let n = 1; n <= SEED_COMMENT_COUNT; n++) {
    comments.insert({
      id: commentId(n),
      articleId: SEED_COMMENTED_ARTICLE,
      authorId: `commenter-${pad2(((n - 1) % 4) + 1)}`,
      body: `Seed comment number ${n} on ${SEED_COMMENTED_ARTICLE}.`,
      createdAt: COMMENT_EPOCH + (n - 1) * COMMENT_SPACING,
    });
  }

  const actions = [
    "user.login",
    "article.publish",
    "comment.create",
    "comment.delete",
  ] as const;

  for (let n = 1; n <= SEED_AUDIT_COUNT; n++) {
    audit.insert({
      id: auditId(n),
      actorId: n % 3 === 0 ? "admin-1" : "user-7",
      action: actions[(n - 1) % actions.length]!,
      subjectId: n % 2 === 0 ? articleId((n % SEED_ARTICLE_COUNT) + 1) : commentId(n),
      at: AUDIT_EPOCH + (n - 1) * AUDIT_SPACING,
    });
  }
}

/** All seeded comment ids, in creation (= createdAt) order. */
export function seededCommentIds(): string[] {
  const ids: string[] = [];
  for (let n = 1; n <= SEED_COMMENT_COUNT; n++) {
    ids.push(commentId(n));
  }
  return ids;
}

/** All seeded article ids, in publication order. */
export function seededArticleIds(): string[] {
  const ids: string[] = [];
  for (let n = 1; n <= SEED_ARTICLE_COUNT; n++) {
    ids.push(articleId(n));
  }
  return ids;
}

/** All seeded audit ids, in chronological order. */
export function seededAuditIds(): string[] {
  const ids: string[] = [];
  for (let n = 1; n <= SEED_AUDIT_COUNT; n++) {
    ids.push(auditId(n));
  }
  return ids;
}
