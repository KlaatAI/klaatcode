/** Small collection helpers shared by the analytics modules. */

/** Groups items by a key function, preserving first-seen key order. */
export function groupBy<T, K>(items: Iterable<T>, keyFn: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const bucket = out.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      out.set(key, [item]);
    }
  }
  return out;
}

/**
 * Stable sort by a numeric key. Array.prototype.sort is stable in all
 * modern engines, but we keep the wrapper for intent and for the copy.
 */
export function sortedBy<T>(items: readonly T[], keyFn: (item: T) => number): T[] {
  return [...items].sort((a, b) => keyFn(a) - keyFn(b));
}

/** Stable sort by a string key (code-unit order). */
export function sortedByString<T>(items: readonly T[], keyFn: (item: T) => string): T[] {
  return [...items].sort((a, b) => {
    const ka = keyFn(a);
    const kb = keyFn(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/** Increments a numeric map entry, initializing to 0. */
export function bump<K>(map: Map<K, number>, key: K, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

/** Adds a value to a Map<K, Set<V>> entry, creating the set on demand. */
export function addToSetMap<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  let set = map.get(key);
  if (!set) {
    set = new Set<V>();
    map.set(key, set);
  }
  set.add(value);
}

/** Sums an iterable of numbers. */
export function sum(values: Iterable<number>): number {
  let total = 0;
  for (const v of values) {
    total += v;
  }
  return total;
}

/** Returns map keys sorted lexicographically (useful for day keys). */
export function sortedKeys<V>(map: Map<string, V>): string[] {
  return [...map.keys()].sort();
}
