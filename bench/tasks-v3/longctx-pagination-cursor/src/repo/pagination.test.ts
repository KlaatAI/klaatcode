import { test, expect } from "bun:test";
import { createDatabase } from "../db/database";
import {
  seedDatabase,
  seededArticleIds,
  seededAuditIds,
  seededCommentIds,
  SEED_COMMENTED_ARTICLE,
} from "../domain/seed";
import { FixedClock } from "../util/clock";
import { ListingService } from "../service/listingService";

function makeService(): ListingService {
  const db = createDatabase();
  seedDatabase(db);
  return new ListingService(db, new FixedClock(999_999));
}

interface HasId {
  readonly id: string;
}

/**
 * Walks a paginated listing to exhaustion through the public service API,
 * optionally running a mutation after the first page (simulating a
 * concurrent writer). Returns the ids seen, in order.
 */
function walk(
  fetchPage: (cursor: string | null | undefined) => {
    items: HasId[];
    nextCursor: string | null;
  },
  afterFirstPage?: () => void,
): string[] {
  const seen: string[] = [];
  let cursor: string | null | undefined = undefined;
  for (let pageNo = 0; pageNo < 20; pageNo++) {
    const page = fetchPage(cursor);
    for (const item of page.items) {
      seen.push(item.id);
    }
    if (pageNo === 0 && afterFirstPage) {
      afterFirstPage();
    }
    if (page.nextCursor === null) {
      return seen;
    }
    cursor = page.nextCursor;
  }
  throw new Error("pagination did not terminate within 20 pages");
}

function duplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      dupes.add(id);
    }
    seen.add(id);
  }
  return [...dupes].sort();
}

// ---------------------------------------------------------------------
// Articles: keyset pagination stays stable while a writer backdates an
// article mid-walk.
// ---------------------------------------------------------------------

test("article listing sees every seeded article exactly once despite a mid-walk backdated publish", () => {
  const service = makeService();
  const seen = walk(
    (cursor) => service.listArticles(4, cursor),
    () => {
      // A migration republishes an old article with its original historic
      // timestamp, sorting it before everything the walker has seen.
      service.publishArticle({
        id: "a90",
        slug: "backdated-import",
        title: "Backdated import",
        authorId: "importer",
        publishedAt: 95_000,
      });
    },
  );
  expect(duplicates(seen)).toEqual([]);
  for (const id of seededArticleIds()) {
    expect(seen).toContain(id);
  }
});

// ---------------------------------------------------------------------
// Audit log: deleting an already-delivered entry mid-walk must not make
// the walker skip entries it has not reached yet.
// ---------------------------------------------------------------------

test("audit walk misses nothing when retention purges an already-seen entry mid-walk", () => {
  const service = makeService();
  const seen = walk(
    (cursor) => service.listAuditTrail(5, cursor),
    () => {
      service.purgeAuditEntry("e02");
    },
  );
  expect(duplicates(seen)).toEqual([]);
  const stillExpected = seededAuditIds().filter((id) => id !== "e02");
  for (const id of stillExpected) {
    expect(seen).toContain(id);
  }
});

// ---------------------------------------------------------------------
// Comments: static walk (no concurrent writers) is the baseline and must
// hold regardless of implementation strategy.
// ---------------------------------------------------------------------

test("comment walk with no concurrent writes yields every comment exactly once, oldest first", () => {
  const service = makeService();
  const seen = walk((cursor) =>
    service.listComments(SEED_COMMENTED_ARTICLE, 4, cursor),
  );
  expect(seen).toEqual(seededCommentIds());
});

test("first comment page is ordered and cursor is an opaque string", () => {
  const service = makeService();
  const page = service.listComments(SEED_COMMENTED_ARTICLE, 5);
  expect(page.items.map((c) => c.id)).toEqual(["c01", "c02", "c03", "c04", "c05"]);
  expect(typeof page.nextCursor).toBe("string");
});

// ---------------------------------------------------------------------
// Comments: concurrent writers mid-walk. These exercise the documented
// cursor contract (resume strictly after the last delivered sort key).
// ---------------------------------------------------------------------

test("comment walk never repeats a comment when a backdated comment lands mid-walk", () => {
  const service = makeService();
  const seen = walk(
    (cursor) => service.listComments(SEED_COMMENTED_ARTICLE, 5, cursor),
    () => {
      // An import lands with its original (early) authorship timestamp,
      // sorting before comments the walker has already delivered.
      service.postComment({
        id: "c90",
        articleId: SEED_COMMENTED_ARTICLE,
        authorId: "importer",
        body: "Imported from the legacy forum.",
        createdAt: 1_500,
      });
    },
  );
  expect(duplicates(seen)).toEqual([]);
  for (const id of seededCommentIds()) {
    expect(seen).toContain(id);
  }
});

test("comment walk never skips an unseen comment when an already-seen comment is deleted mid-walk", () => {
  const service = makeService();
  const seen = walk(
    (cursor) => service.listComments(SEED_COMMENTED_ARTICLE, 5, cursor),
    () => {
      // The author retracts a comment from the first page after the walker
      // has already passed it.
      service.removeComment("c02");
    },
  );
  expect(duplicates(seen)).toEqual([]);
  const stillExpected = seededCommentIds().filter((id) => id !== "c02");
  for (const id of stillExpected) {
    expect(seen).toContain(id);
  }
});
