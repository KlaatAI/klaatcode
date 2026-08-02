import { Consignment, CONSIGNMENT_STATUSES } from "../domain/types";

export class ConsignmentRepo {
  private byId = new Map<string, Consignment>();

  add(input: { consignmentId: string; destination: string; weightKg: number }): Consignment {
    if (this.byId.has(input.consignmentId)) {
      throw new Error(`duplicate consignment ${input.consignmentId}`);
    }
    const c: Consignment = {
      consignmentId: input.consignmentId,
      destination: input.destination,
      weightKg: input.weightKg,
      status: CONSIGNMENT_STATUSES[0],
      dispatchedAt: null,
    };
    this.byId.set(c.consignmentId, c);
    return c;
  }

  getById(id: string): Consignment {
    const c = this.byId.get(id);
    if (!c) throw new Error(`consignment ${id} not found`);
    return c;
  }

  update(c: Consignment): void {
    if (!this.byId.has(c.consignmentId)) {
      throw new Error(`consignment ${c.consignmentId} not found`);
    }
    this.byId.set(c.consignmentId, c);
  }

  all(): Consignment[] {
    return [...this.byId.values()];
  }
}
