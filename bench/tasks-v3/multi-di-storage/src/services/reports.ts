import { FileStore } from "../storage/filestore";

const PREFIX = "reports/";

export class ReportService {
  // Storage is hardwired: every method spins up its own FileStore.
  async save(id: string, lines: string[]): Promise<string> {
    const store = new FileStore();
    const key = PREFIX + id;
    await store.put(key, lines.join("\n"));
    return key;
  }

  async load(id: string): Promise<string[] | null> {
    const store = new FileStore();
    const raw = await store.get(PREFIX + id);
    return raw === null ? null : raw.split("\n");
  }

  async listIds(): Promise<string[]> {
    const store = new FileStore();
    const keys = await store.list(PREFIX);
    return keys.map((k) => k.slice(PREFIX.length));
  }

  async remove(id: string): Promise<boolean> {
    const store = new FileStore();
    return store.delete(PREFIX + id);
  }
}
