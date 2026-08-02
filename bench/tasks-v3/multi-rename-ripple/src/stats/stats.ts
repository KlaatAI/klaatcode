import { Shipment } from "../domain/types";

export function dispatchedCount(items: Shipment[]): number {
  return items.filter((s) => s.shippedAt !== null).length;
}

export function totalWeightKg(items: Shipment[]): number {
  return items.reduce((sum, s) => sum + s.weightKg, 0);
}

export function byStatus(items: Shipment[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of items) {
    out[s.status] = (out[s.status] ?? 0) + 1;
  }
  return out;
}

/** Returns the id of the heaviest shipment, or null for an empty list. */
export function heaviest(items: Shipment[]): string | null {
  if (items.length === 0) return null;
  let best = items[0];
  for (const s of items) {
    if (s.weightKg > best.weightKg) best = s;
  }
  return best.shipmentId;
}
