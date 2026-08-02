import { Shipment } from "../domain/types";
import { ShipmentRepo } from "../repo/repo";

export class TrackingService {
  constructor(private repo: ShipmentRepo) {}

  dispatch(id: string, atIso: string): Shipment {
    const s = this.repo.getById(id);
    if (s.status !== "pending") {
      throw new Error(`shipment ${s.shipmentId} cannot be dispatched from ${s.status}`);
    }
    s.status = "dispatched";
    s.shippedAt = atIso;
    this.repo.update(s);
    return s;
  }

  deliver(id: string): Shipment {
    const s = this.repo.getById(id);
    if (s.status !== "dispatched") {
      throw new Error(`shipment ${s.shipmentId} cannot be delivered from ${s.status}`);
    }
    s.status = "delivered";
    this.repo.update(s);
    return s;
  }
}
