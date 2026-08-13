import { FileStore } from "../storage/filestore";

export interface ManifestEntry {
  key: string;
  bytes: number;
}

export class ExportService {
  // Also hardwired to the concrete FileStore.
  async exportAll(prefix: string): Promise<string> {
    const store = new FileStore();
    const keys = await store.list(prefix);
    const sections: string[] = [];
    for (const key of keys) {
      const value = await store.get(key);
      sections.push(`## ${key}\n${value ?? ""}`);
    }
    return sections.join("\n\n");
  }

  async exportManifest(prefix: string): Promise<ManifestEntry[]> {
    const store = new FileStore();
    const keys = await store.list(prefix);
    const entries: ManifestEntry[] = [];
    for (const key of keys) {
      const value = await store.get(key);
      entries.push({ key, bytes: new TextEncoder().encode(value ?? "").length });
    }
    return entries;
  }
}
