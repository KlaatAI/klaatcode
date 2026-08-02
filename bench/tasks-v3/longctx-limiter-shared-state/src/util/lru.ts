/**
 * Small bounded LRU map used for memoizing directory lookups. Eviction is
 * strictly least-recently-USED: both get and set refresh recency.
 *
 * This is a generic utility; nothing about rate limiting lives here. Rate
 * limit budgets must NOT be stored in an LRU — evicting a hot user's counter
 * would silently refill their budget — which is why the limiter uses a plain
 * Map keyed by user id instead.
 */
export class LruMap<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`LruMap: capacity must be a positive integer, got ${capacity}`);
    }
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key)!;
    // Refresh recency by re-inserting at the back.
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.capacity) {
      // Map iteration order is insertion order; the first key is the LRU.
      const oldest = this.map.keys().next().value as K;
      this.map.delete(oldest);
    }
    this.map.set(key, value);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}
