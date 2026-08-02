import { FileStore } from "../storage/filestore";

/**
 * Moves each report id from "reports/<id>" to "archive/<id>", deleting the
 * original. Ids with no stored report are skipped. Returns how many reports
 * were actually moved.
 */
export async function runArchiveJob(ids: string[]): Promise<number> {
  const store = new FileStore();
  let moved = 0;
  for (const id of ids) {
    const value = await store.get(`reports/${id}`);
    if (value === null) continue;
    await store.put(`archive/${id}`, value);
    await store.delete(`reports/${id}`);
    moved++;
  }
  return moved;
}
