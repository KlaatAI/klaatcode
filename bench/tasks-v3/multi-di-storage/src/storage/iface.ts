/**
 * Storage abstraction the services should depend on.
 * Implementations must behave like a flat key/value blob store:
 *  - get: resolves the stored string, or null when the key is absent
 *  - put: stores/overwrites the value under the key
 *  - list: resolves all keys starting with `prefix`, sorted ascending
 *  - delete: removes the key; resolves true if it existed
 */
export interface Storage {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  delete(key: string): Promise<boolean>;
}
