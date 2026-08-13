import { Consignment } from "../domain/types";
import { ConsignmentRepo } from "../repo/repo";

export class TrackingService {
  constructor(private repo: ConsignmentRepo) {}

  dispatch(id: string, atIso: string): Consignment {
    const c = this.repo.getById(id);
    if (c.status !== "pending") {
      throw new Error(`consignment ${c.consignmentId} cannot be dispatched from ${c.status}`);
    }
    c.status = "dispatched";
    c.dispatchedAt = atIso;
    this.repo.update(c);
    return c;
  }

  deliver(id: string): Consignment {
    const c = this.repo.getById(id);
    if (c.status !== "dispatched") {
      throw new Error(`consignment ${c.consignmentId} cannot be delivered from ${c.status}`);
    }
    c.status = "delivered";
    this.repo.update(c);
    return c;
  }
}
