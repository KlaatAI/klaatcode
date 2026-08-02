/**
 * Public entry point for everything the API layer exposes.
 *
 * The service validates inputs, delegates to the repositories, and maps rows
 * to wire DTOs. API handlers and tests must go through this class; the
 * repositories are an implementation detail.
 */

import { Database } from "../db/database";
import { ArticlesRepo } from "../repo/articlesRepo";
import { AuditRepo } from "../repo/auditRepo";
import { CommentsRepo } from "../repo/commentsRepo";
import type { Page } from "../repo/types";
import type { Article, AuditEntry, Comment } from "../domain/models";
import { SystemClock, type Clock } from "../util/clock";
import {
  assertEpochMillis,
  assertNonEmptyString,
  assertValidLimit,
} from "../util/validation";

export interface ArticleDto {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly publishedAt: number;
}

export interface CommentDto {
  readonly id: string;
  readonly articleId: string;
  readonly authorId: string;
  readonly body: string;
  readonly createdAt: number;
}

export interface AuditDto {
  readonly id: string;
  readonly actorId: string;
  readonly action: string;
  readonly at: number;
}

function toArticleDto(a: Article): ArticleDto {
  return { id: a.id, slug: a.slug, title: a.title, publishedAt: a.publishedAt };
}

function toCommentDto(c: Comment): CommentDto {
  return {
    id: c.id,
    articleId: c.articleId,
    authorId: c.authorId,
    body: c.body,
    createdAt: c.createdAt,
  };
}

function toAuditDto(e: AuditEntry): AuditDto {
  return { id: e.id, actorId: e.actorId, action: e.action, at: e.at };
}

function mapPage<T, U>(page: Page<T>, map: (item: T) => U): Page<U> {
  return { items: page.items.map(map), nextCursor: page.nextCursor };
}

export class ListingService {
  private readonly articles: ArticlesRepo;
  private readonly comments: CommentsRepo;
  private readonly audit: AuditRepo;

  constructor(db: Database, private readonly clock: Clock = new SystemClock()) {
    this.articles = new ArticlesRepo(db);
    this.comments = new CommentsRepo(db);
    this.audit = new AuditRepo(db);
  }

  // ------------------------------------------------------------------
  // Listings
  // ------------------------------------------------------------------

  /** Articles, oldest publication first. */
  listArticles(limit: number, cursor?: string | null): Page<ArticleDto> {
    assertValidLimit(limit);
    return mapPage(this.articles.list({ limit, cursor }), toArticleDto);
  }

  /** Comments on one article, oldest first. */
  listComments(
    articleId: string,
    limit: number,
    cursor?: string | null,
  ): Page<CommentDto> {
    assertNonEmptyString(articleId, "articleId");
    assertValidLimit(limit);
    return mapPage(
      this.comments.listForArticle(articleId, { limit, cursor }),
      toCommentDto,
    );
  }

  /** Audit trail, chronological. */
  listAuditTrail(limit: number, cursor?: string | null): Page<AuditDto> {
    assertValidLimit(limit);
    return mapPage(this.audit.list({ limit, cursor }), toAuditDto);
  }

  // ------------------------------------------------------------------
  // Mutations (used by tests to simulate concurrent writers mid-walk)
  // ------------------------------------------------------------------

  /** Publishes a new article at an explicit timestamp. */
  publishArticle(input: {
    id: string;
    slug: string;
    title: string;
    authorId: string;
    publishedAt?: number;
  }): ArticleDto {
    assertNonEmptyString(input.id, "id");
    assertNonEmptyString(input.slug, "slug");
    const publishedAt = input.publishedAt ?? this.clock.now();
    assertEpochMillis(publishedAt, "publishedAt");
    const article = this.articles.create({
      id: input.id,
      slug: input.slug,
      title: input.title,
      authorId: input.authorId,
      publishedAt,
    });
    return toArticleDto(article);
  }

  /** Removes an article entirely. */
  unpublishArticle(id: string): void {
    assertNonEmptyString(id, "id");
    this.articles.delete(id);
  }

  /**
   * Posts a comment. `createdAt` may be supplied explicitly — imports and
   * backfills preserve the original authorship time rather than the time
   * the row lands in our database.
   */
  postComment(input: {
    id: string;
    articleId: string;
    authorId: string;
    body: string;
    createdAt?: number;
  }): CommentDto {
    assertNonEmptyString(input.id, "id");
    assertNonEmptyString(input.articleId, "articleId");
    const createdAt = input.createdAt ?? this.clock.now();
    assertEpochMillis(createdAt, "createdAt");
    const comment = this.comments.create({
      id: input.id,
      articleId: input.articleId,
      authorId: input.authorId,
      body: input.body,
      createdAt,
    });
    return toCommentDto(comment);
  }

  /** Deletes a comment (author retraction or moderation). */
  removeComment(id: string): void {
    assertNonEmptyString(id, "id");
    this.comments.delete(id);
  }

  /** Appends an audit entry at an explicit timestamp. */
  recordAudit(input: {
    id: string;
    actorId: string;
    action: AuditEntry["action"];
    subjectId: string;
    at?: number;
  }): AuditDto {
    assertNonEmptyString(input.id, "id");
    const at = input.at ?? this.clock.now();
    assertEpochMillis(at, "at");
    const entry = this.audit.append({
      id: input.id,
      actorId: input.actorId,
      action: input.action,
      subjectId: input.subjectId,
      at,
    });
    return toAuditDto(entry);
  }

  /** Retention: drops one audit entry. */
  purgeAuditEntry(id: string): void {
    assertNonEmptyString(id, "id");
    this.audit.purge(id);
  }
}
