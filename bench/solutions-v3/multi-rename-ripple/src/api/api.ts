import { ConsignmentRepo } from "../repo/repo";
import { formatStatusLine } from "../format/formatter";

export interface CreateBody {
  consignmentId: string;
  destination: string;
  weightKg: number;
}

export function createApi(repo: ConsignmentRepo) {
  return {
    create(body: CreateBody) {
      const c = repo.add({
        consignmentId: body.consignmentId,
        destination: body.destination,
        weightKg: body.weightKg,
      });
      return {
        ok: true,
        consignment: {
          consignmentId: c.consignmentId,
          destination: c.destination,
          weightKg: c.weightKg,
          status: c.status,
          dispatchedAt: c.dispatchedAt,
        },
      };
    },

    get(id: string) {
      const c = repo.getById(id);
      return {
        ok: true,
        consignment: {
          consignmentId: c.consignmentId,
          status: c.status,
          dispatchedAt: c.dispatchedAt,
          label: formatStatusLine(c),
        },
      };
    },
  };
}
