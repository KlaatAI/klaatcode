import { Consignment } from "../domain/types";

export function formatLabel(c: Consignment): string {
  return `Consignment ${c.consignmentId} -> ${c.destination} (${c.weightKg.toFixed(1)} kg)`;
}

export function formatStatusLine(c: Consignment): string {
  if (c.dispatchedAt) {
    return `Consignment ${c.consignmentId}: ${c.status} at ${c.dispatchedAt}`;
  }
  return `Consignment ${c.consignmentId}: ${c.status}`;
}
