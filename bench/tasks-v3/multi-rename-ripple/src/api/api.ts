import { ShipmentRepo } from "../repo/repo";
import { formatStatusLine } from "../format/formatter";

export interface CreateBody {
  shipmentId: string;
  destination: string;
  weightKg: number;
}

export function createApi(repo: ShipmentRepo) {
  return {
    create(body: CreateBody) {
      const s = repo.add({
        shipmentId: body.shipmentId,
        destination: body.destination,
        weightKg: body.weightKg,
      });
      return {
        ok: true,
        shipment: {
          shipmentId: s.shipmentId,
          destination: s.destination,
          weightKg: s.weightKg,
          status: s.status,
          shippedAt: s.shippedAt,
        },
      };
    },

    get(id: string) {
      const s = repo.getById(id);
      return {
        ok: true,
        shipment: {
          shipmentId: s.shipmentId,
          status: s.status,
          shippedAt: s.shippedAt,
          label: formatStatusLine(s),
        },
      };
    },
  };
}
