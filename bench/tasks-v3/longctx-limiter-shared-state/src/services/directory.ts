/**
 * In-process user directory. In the real deployment this fronts the identity
 * service; for the benchmark fixture it is a static token table so requests
 * are fully deterministic.
 */
import { LruMap } from "../util/lru";

export interface UserRecord {
  id: string;
  role: "admin" | "member" | "viewer";
  displayName: string;
}

const TOKEN_TABLE: Record<string, UserRecord> = {
  "tok-alice": { id: "alice", role: "admin", displayName: "Alice Vance" },
  "tok-bob": { id: "bob", role: "member", displayName: "Bob Ortega" },
  "tok-carol": { id: "carol", role: "member", displayName: "Carol Nkemi" },
  "tok-dave": { id: "dave", role: "viewer", displayName: "Dave Liu" },
};

export class Directory {
  /**
   * Memoizes token lookups. In production this avoids re-hitting the
   * identity service on every request; entries are per-token, so the cache
   * can never cross credentials between users.
   */
  private readonly tokenCache = new LruMap<string, UserRecord | null>(128);

  /** Resolve a bearer token to a user, or undefined for unknown tokens. */
  lookupToken(token: string): UserRecord | undefined {
    const cached = this.tokenCache.get(token);
    if (cached !== undefined) {
      return cached ?? undefined;
    }
    const record = TOKEN_TABLE[token];
    this.tokenCache.set(token, record ?? null);
    return record;
  }

  /** Resolve a user id (used by services rendering profile data). */
  lookupUser(userId: string): UserRecord | undefined {
    for (const record of Object.values(TOKEN_TABLE)) {
      if (record.id === userId) return record;
    }
    return undefined;
  }

  /** All known user ids, sorted for deterministic listings. */
  listUserIds(): string[] {
    return Object.values(TOKEN_TABLE)
      .map((r) => r.id)
      .sort();
  }
}
