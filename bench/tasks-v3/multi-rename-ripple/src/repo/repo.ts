import { Shipment, SHIPMENT_STATUSES } from "../domain/types";

export class ShipmentRepo {
  private byId = new Map<string, Shipment>();

  add(input: { shipmentId: string; destination: string; weightKg: number }): Shipment {
    if (this.byId.has(input.shipmentId)) {
      throw new Error(`duplicate shipment ${input.shipmentId}`);
    }
    const s: Shipment = {
      shipmentId: input.shipmentId,
      destination: input.destination,
      weightKg: input.weightKg,
      status: SHIPMENT_STATUSES[0],
      shippedAt: null,
    };
    this.byId.set(s.shipmentId, s);
    return s;
  }

  getById(id: string): Shipment {
    const s = this.byId.get(id);
    if (!s) throw new Error(`shipment ${id} not found`);
    return s;
  }

  update(s: Shipment): void {
    if (!this.byId.has(s.shipmentId)) {
      throw new Error(`shipment ${s.shipmentId} not found`);
    }
    this.byId.set(s.shipmentId, s);
  }

  all(): Shipment[] {
    return [...this.byId.values()];
  }
}
