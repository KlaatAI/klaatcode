import { test, expect } from "bun:test";
import { ConsignmentRepo } from "./repo/repo";
import { TrackingService } from "./service/tracking";
import { formatLabel, formatStatusLine } from "./format/formatter";
import { isConsignment } from "./domain/types";

test("repo creates pending consignments with the renamed fields", () => {
  const repo = new ConsignmentRepo();
  const c = repo.add({ consignmentId: "CN-1", destination: "Berlin", weightKg: 2.5 });
  expect(c.consignmentId).toBe("CN-1");
  expect(c.status).toBe("pending");
  expect(c.dispatchedAt).toBeNull();
  expect(isConsignment(c)).toBe(true);
});

test("repo rejects duplicates and unknown ids using the new vocabulary", () => {
  const repo = new ConsignmentRepo();
  repo.add({ consignmentId: "CN-1", destination: "Berlin", weightKg: 2.5 });
  expect(() =>
    repo.add({ consignmentId: "CN-1", destination: "Oslo", weightKg: 1 }),
  ).toThrow(/duplicate consignment CN-1/);
  expect(() => repo.getById("CN-9")).toThrow(/consignment CN-9 not found/);
});

test("tracking service dispatches and delivers via dispatchedAt", () => {
  const repo = new ConsignmentRepo();
  repo.add({ consignmentId: "CN-2", destination: "Oslo", weightKg: 4 });
  const svc = new TrackingService(repo);

  const dispatched = svc.dispatch("CN-2", "2026-01-02T10:00:00Z");
  expect(dispatched.status).toBe("dispatched");
  expect(dispatched.dispatchedAt).toBe("2026-01-02T10:00:00Z");

  const delivered = svc.deliver("CN-2");
  expect(delivered.status).toBe("delivered");
  expect(() => svc.dispatch("CN-2", "2026-01-03T10:00:00Z")).toThrow(
    /consignment CN-2 cannot be dispatched from delivered/,
  );
});

test("formatter speaks Consignment, not Shipment", () => {
  const repo = new ConsignmentRepo();
  const c = repo.add({ consignmentId: "CN-1", destination: "Berlin", weightKg: 2.5 });
  expect(formatLabel(c)).toBe("Consignment CN-1 -> Berlin (2.5 kg)");
  expect(formatStatusLine(c)).toBe("Consignment CN-1: pending");

  new TrackingService(repo).dispatch("CN-1", "2026-01-02T10:00:00Z");
  expect(formatStatusLine(repo.getById("CN-1"))).toBe(
    "Consignment CN-1: dispatched at 2026-01-02T10:00:00Z",
  );
});
