/**
 * Tokenization for the in-memory search index. ASCII-folding is out of
 * scope; we lowercase, strip punctuation, and split on whitespace.
 */
export function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9@. ]+/g, " ").replace(/\s+/g, " ").trim();
}

export function tokenize(text: string): string[] {
  const normalized = normalize(text);
  if (normalized.length === 0) return [];
  const tokens = new Set<string>();
  for (const raw of normalized.split(" ")) {
    if (raw.length === 0) continue;
    tokens.add(raw);
    // Also index the local part of emails ("ada@ex.com" -> "ada").
    if (raw.includes("@")) {
      const local = raw.split("@")[0]!;
      if (local.length > 0) tokens.add(local);
    }
  }
  return [...tokens].sort();
}

/** Prefix match used for typeahead queries. */
export function tokenMatchesQuery(token: string, queryToken: string): boolean {
  return token === queryToken || token.startsWith(queryToken);
}
