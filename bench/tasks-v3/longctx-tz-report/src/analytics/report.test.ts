import { test, expect } from "bun:test";

import { generateOrgReport, rowForDay, totalActiveUserDays } from "./report";
import type { RawEvent } from "./types";
import { OrgRegistry } from "../orgs/registry";
import { renderDailyTable } from "../format/table";
import { utcMs } from "../time/clock";

/**
 * Orgs with fixed offsets:
 *   acme-in  UTC+05:30 (IST, +330)
 *   west-co  UTC-08:00 (-480)
 *   utc-org  UTC+00:00 (control)
 */
function makeRegistry(): OrgRegistry {
  return new OrgRegistry([
    { id: "acme-in", name: "Acme India", utcOffsetMinutes: 330, plan: "team" },
    { id: "west-co", name: "West Coast Co", utcOffsetMinutes: -480, plan: "enterprise" },
    { id: "utc-org", name: "Zulu Org", utcOffsetMinutes: 0, plan: "free" },
  ]);
}

function ev(orgId: string, userId: string, iso: string, name = "page_view"): RawEvent {
  return { orgId, userId, name, timestamp: utcMs(iso) };
}

const events: RawEvent[] = [
  // acme-in (+05:30). 2024-03-10T19:30Z is already 01:00 on Mar 11 in IST.
  ev("acme-in", "u1", "2024-03-10T19:30:00Z"),
  ev("acme-in", "u1", "2024-03-10T19:40:00Z", "click"),
  ev("acme-in", "u2", "2024-03-10T10:00:00Z"), // 15:30 IST, Mar 10 both ways
  ev("acme-in", "u3", "2024-03-11T05:00:00Z"), // 10:30 IST, Mar 11 both ways

  // west-co (-08:00). 2024-03-11T06:30Z is still 22:30 on Mar 10 locally.
  ev("west-co", "u9", "2024-03-11T06:30:00Z"),
  ev("west-co", "u8", "2024-03-11T20:00:00Z"), // 12:00 local, Mar 11 both ways

  // utc-org control: midday events, plus one exact duplicate to exercise dedupe.
  ev("utc-org", "u5", "2024-03-11T12:00:00Z"),
  ev("utc-org", "u5", "2024-03-11T12:00:00Z"),
  ev("utc-org", "u6", "2024-03-11T13:00:00Z"),
];

test("IST org: users active just after local midnight count toward the local day", () => {
  const report = generateOrgReport(events, makeRegistry(), "acme-in");

  // u1's activity is 01:00-01:10 IST on Mar 11 — it belongs to Mar 11.
  const mar10 = rowForDay(report, "2024-03-10");
  const mar11 = rowForDay(report, "2024-03-11");
  expect(mar10?.activeUsers).toBe(1); // only u2
  expect(mar11?.activeUsers).toBe(2); // u1 and u3
});

test("IST org: event totals follow the org-local day too", () => {
  const report = generateOrgReport(events, makeRegistry(), "acme-in");
  expect(rowForDay(report, "2024-03-10")?.eventCount).toBe(1);
  expect(rowForDay(report, "2024-03-11")?.eventCount).toBe(3);
});

test("negative-offset org: late-evening local activity stays on the local day", () => {
  const report = generateOrgReport(events, makeRegistry(), "west-co");
  // u9 at 22:30 local on Mar 10 must count on Mar 10, not Mar 11.
  expect(rowForDay(report, "2024-03-10")?.activeUsers).toBe(1);
  expect(rowForDay(report, "2024-03-11")?.activeUsers).toBe(1);
});

test("session attribution agrees with the report's day rows", () => {
  const report = generateOrgReport(events, makeRegistry(), "acme-in");
  // u1's two events form one session starting Mar 11 local; u2 and u3
  // have one session each on their local days.
  expect(rowForDay(report, "2024-03-10")?.sessionCount).toBe(1);
  expect(rowForDay(report, "2024-03-11")?.sessionCount).toBe(2);
});

test("active-user-days total is conserved across the org", () => {
  const report = generateOrgReport(events, makeRegistry(), "acme-in");
  expect(totalActiveUserDays(report)).toBe(3);
});

test("midday activity is unaffected by offsets and duplicates are dropped", () => {
  const report = generateOrgReport(events, makeRegistry(), "utc-org");
  const row = rowForDay(report, "2024-03-11");
  expect(row?.activeUsers).toBe(2);
  expect(row?.eventCount).toBe(2); // the duplicate u5 event was deduped
});

test("weekly rollup conserves the control org's totals", () => {
  const report = generateOrgReport(events, makeRegistry(), "utc-org");
  expect(report.weekly.length).toBe(1);
  expect(report.weekly[0]?.weekStart).toBe("2024-03-11"); // Mar 11 2024 is a Monday
  expect(report.weekly[0]?.eventCount).toBe(2);
});

test("rendered table lists org-local days", () => {
  const report = generateOrgReport(events, makeRegistry(), "west-co");
  const table = renderDailyTable(report);
  expect(table).toContain("2024-03-10");
  expect(table.split("\n")[0]).toContain("active");
});
