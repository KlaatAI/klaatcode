import { Shipment } from "../domain/types";

export function formatLabel(s: Shipment): string {
  return `Shipment ${s.shipmentId} -> ${s.destination} (${s.weightKg.toFixed(1)} kg)`;
}

export function formatStatusLine(s: Shipment): string {
  if (s.shippedAt) {
    return `Shipment ${s.shipmentId}: ${s.status} at ${s.shippedAt}`;
  }
  return `Shipment ${s.shipmentId}: ${s.status}`;
}
