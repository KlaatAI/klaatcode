import type { User } from "../users/types";
import { isActive } from "../users/types";
import { UserStore } from "../users/store";
import { tokenize } from "./tokenize";

export interface IndexedDocument {
  userId: string;
  tokens: string[];
  /** Higher boost ranks the document earlier for equal token matches. */
  boost: number;
}

/**
 * Builds and maintains the in-memory search index over users. Fields
 * indexed: displayName (canonical name, migration 0007), fullName, email.
 * Suspended/deleted users are excluded (migration 0006).
 */
export class SearchIndexer {
  private readonly docs = new Map<string, IndexedDocument>();

  constructor(private readonly store: UserStore) {}

  indexUser(userId: string): IndexedDocument | null {
    const user = this.store.get(userId);
    if (!isActive(user)) {
      this.docs.delete(userId);
      return null;
    }
    const doc = this.buildDocument(user);
    this.docs.set(userId, doc);
    return { ...doc, tokens: [...doc.tokens] };
  }

  reindexAll(): number {
    this.docs.clear();
    let count = 0;
    for (const user of this.store.listActive()) {
      this.docs.set(user.id, this.buildDocument(user));
      count += 1;
    }
    return count;
  }

  removeUser(userId: string): void {
    this.docs.delete(userId);
  }

  documents(): IndexedDocument[] {
    return [...this.docs.values()]
      .map((d) => ({ ...d, tokens: [...d.tokens] }))
      .sort((a, b) => a.userId.localeCompare(b.userId));
  }

  documentFor(userId: string): IndexedDocument | undefined {
    const doc = this.docs.get(userId);
    return doc ? { ...doc, tokens: [...doc.tokens] } : undefined;
  }

  private buildDocument(user: User): IndexedDocument {
    const tokens = new Set<string>([
      ...tokenize(user.displayName),
      ...tokenize(user.fullName),
      ...tokenize(user.email),
    ]);
    // Recently created accounts get a small boost in typeahead.
    const boost = Date.parse(user.createdAt) >= Date.parse("2026-01-01T00:00:00Z") ? 2 : 1;
    return { userId: user.id, tokens: [...tokens].sort(), boost };
  }
}
