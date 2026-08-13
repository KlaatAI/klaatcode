import { Consignment } from "../domain/types";

export function dispatchedCount(items: Consignment[]): number {
  return items.filter((c) => c.dispatchedAt !== null).length;
}

export function totalWeightKg(items: Consignment[]): number {
  return items.reduce((sum, c) => sum + c.weightKg, 0);
}

export function byStatus(items: Consignment[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of items) {
    out[c.status] = (out[c.status] ?? 0) + 1;
  }
  return out;
}

/** Returns the id of the heaviest consignment, or null for an empty list. */
export function heaviest(items: Consignment[]): string | null {
  if (items.length === 0) return null;
  let best = items[0];
  for (const c of items) {
    if (c.weightKg > best.weightKg) best = c;
  }
  return best.consignmentId;
}
