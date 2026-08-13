import type { Storage } from "./iface";

// Simulates a shared on-disk store: every FileStore instance reads and writes
// the same underlying "disk", and each operation pays a small async latency.
const DISK = new Map<string, string>();

function diskTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1));
}

export class FileStore implements Storage {
  async get(key: string): Promise<string | null> {
    await diskTick();
    return DISK.has(key) ? DISK.get(key)! : null;
  }

  async put(key: string, value: string): Promise<void> {
    await diskTick();
    DISK.set(key, value);
  }

  async list(prefix: string): Promise<string[]> {
    await diskTick();
    return [...DISK.keys()].filter((k) => k.startsWith(prefix)).sort();
  }

  async delete(key: string): Promise<boolean> {
    await diskTick();
    return DISK.delete(key);
  }
}
