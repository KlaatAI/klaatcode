import { test, expect } from "bun:test";
import type { Consignment } from "./domain/types";
import { dispatchedCount, totalWeightKg, byStatus, heaviest } from "./stats/stats";
import { ConsignmentRepo } from "./repo/repo";
import { createApi } from "./api/api";

const fleet: Consignment[] = [
  { consignmentId: "CN-1", destination: "Berlin", weightKg: 2.5, status: "pending", dispatchedAt: null },
  { consignmentId: "CN-2", destination: "Oslo", weightKg: 7.25, status: "dispatched", dispatchedAt: "2026-01-02T10:00:00Z" },
  { consignmentId: "CN-3", destination: "Lima", weightKg: 4, status: "delivered", dispatchedAt: "2026-01-01T08:00:00Z" },
];

test("stats read the renamed dispatchedAt/consignmentId fields", () => {
  expect(dispatchedCount(fleet)).toBe(2);
  expect(totalWeightKg(fleet)).toBeCloseTo(13.75, 10);
  expect(byStatus(fleet)).toEqual({ pending: 1, dispatched: 1, delivered: 1 });
  expect(heaviest(fleet)).toBe("CN-2");
  expect(heaviest([])).toBeNull();
});

test("api payloads use the consignment envelope and renamed fields", () => {
  const repo = new ConsignmentRepo();
  const api = createApi(repo);

  const created = api.create({ consignmentId: "CN-7", destination: "Kyoto", weightKg: 1.2 });
  expect(created.ok).toBe(true);
  expect(created.consignment).toEqual({
    consignmentId: "CN-7",
    destination: "Kyoto",
    weightKg: 1.2,
    status: "pending",
    dispatchedAt: null,
  });

  const fetched = api.get("CN-7");
  expect(fetched.consignment.consignmentId).toBe("CN-7");
  expect(fetched.consignment.dispatchedAt).toBeNull();
  expect(fetched.consignment.label).toBe("Consignment CN-7: pending");
});
