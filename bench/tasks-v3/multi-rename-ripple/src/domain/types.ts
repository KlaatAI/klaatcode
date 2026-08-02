// Domain model. NOTE: "Shipment" was renamed to "Consignment" here
// (shipmentId -> consignmentId, shippedAt -> dispatchedAt,
// SHIPMENT_STATUSES -> CONSIGNMENT_STATUSES, ShipmentStatus -> ConsignmentStatus).
// The rest of the codebase has not caught up yet.

export const CONSIGNMENT_STATUSES = ["pending", "dispatched", "delivered"] as const;

export type ConsignmentStatus = (typeof CONSIGNMENT_STATUSES)[number];

export interface Consignment {
  consignmentId: string;
  destination: string;
  weightKg: number;
  status: ConsignmentStatus;
  /** ISO timestamp; null until the consignment is dispatched. */
  dispatchedAt: string | null;
}

export function isConsignment(v: unknown): v is Consignment {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.consignmentId === "string" &&
    typeof c.destination === "string" &&
    typeof c.weightKg === "number" &&
    CONSIGNMENT_STATUSES.includes(c.status as ConsignmentStatus) &&
    (c.dispatchedAt === null || typeof c.dispatchedAt === "string")
  );
}
