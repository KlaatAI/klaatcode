import { SearchIndexer } from "./indexer";
import { tokenize, tokenMatchesQuery } from "./tokenize";

export interface SearchHit {
  userId: string;
  score: number;
}

/**
 * Query layer over the search index. Scoring: one point per matched
 * query token (prefix matches count), multiplied by the document boost.
 * Ties break by userId so results are stable.
 */
export function search(index: SearchIndexer, query: string, limit = 10): SearchHit[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];
  const hits: SearchHit[] = [];
  for (const doc of index.documents()) {
    let matched = 0;
    for (const qt of queryTokens) {
      if (doc.tokens.some((t) => tokenMatchesQuery(t, qt))) {
        matched += 1;
      }
    }
    if (matched === queryTokens.length) {
      hits.push({ userId: doc.userId, score: matched * doc.boost });
    }
  }
  hits.sort((a, b) => b.score - a.score || a.userId.localeCompare(b.userId));
  return hits.slice(0, limit);
}

/** Convenience wrapper returning just ids, best match first. */
export function searchIds(index: SearchIndexer, query: string, limit = 10): string[] {
  return search(index, query, limit).map((h) => h.userId);
}
