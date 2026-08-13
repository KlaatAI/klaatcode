/**
 * Shared repository-layer types.
 */

/** One page of results plus the token for fetching the next page. */
export interface Page<T> {
  readonly items: T[];
  /**
   * Opaque token for the next page, or null when this page is known to be
   * the last one. Passing the token back to the same listing resumes
   * strictly after the last item of this page.
   */
  readonly nextCursor: string | null;
}

/** Options accepted by every list() method in the repository layer. */
export interface ListOptions {
  /** Maximum number of rows to return. Validated by the service layer. */
  readonly limit: number;
  /** Cursor from a previous page, or undefined for the first page. */
  readonly cursor?: string | null;
}

/** An empty page, shared to avoid allocating in hot paths. */
export function emptyPage<T>(): Page<T> {
  return { items: [], nextCursor: null };
}
