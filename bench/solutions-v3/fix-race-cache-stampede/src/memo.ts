export type AsyncLoader<T> = (key: string) => Promise<T>;

/**
 * Memoizes an async loader per key.
 *
 * Contract:
 * - While a load for a key is in flight, concurrent callers for that key
 *   share the single underlying load (the loader runs once per key).
 * - Successful results are cached indefinitely.
 * - Failed loads are not cached: every waiter sees the rejection, and a
 *   later call retries the loader from scratch.
 */
export function memoizeAsync<T>(loader: AsyncLoader<T>): (key: string) => Promise<T> {
  const cache = new Map<string, Promise<T>>();

  return (key: string): Promise<T> => {
    const cached = cache.get(key);
    if (cached) return cached;

    // Register the promise synchronously, before any await, so concurrent
    // callers observe the in-flight load. Failures evict themselves so a
    // bad load does not poison the key.
    const promise = loader(key).catch((err) => {
      cache.delete(key);
      throw err;
    });
    cache.set(key, promise);
    return promise;
  };
}
