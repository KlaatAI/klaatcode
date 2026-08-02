/**
 * Public report API.
 *
 * This is the only module callers (and tests) should import. It wires
 * the pipeline together:
 *
 *   ingest -> per-org split -> sessions + daily aggregation -> rows ->
 *   weekly rollup
 *
 * Every row's `day` is an org-local calendar day per the convention in
 * src/time/day.ts.
 */

import type { RawEvent, DailyRow, OrgReport, ReportOptions } from "./types";
import type { NormalizedEvent } from "./types";
import { ingestEvents } from "./ingest";
import { buildSessions, sessionsByDay } from "./session";
import { aggregateDaily, aggregateDayKeys, activeUsersOn } from "./aggregate";
import { rollupWeekly } from "./rollup";
import type { Org, OrgRegistry } from "../orgs/registry";
import { compareDayKeys } from "../time/day";
import { groupBy } from "../util/collections";

/**
 * Builds the daily-active report for one org from raw events.
 * Events belonging to other orgs are ignored.
 */
export function generateOrgReport(
  raw: RawEvent[],
  registry: OrgRegistry,
  orgId: string,
  options: ReportOptions = {},
): OrgReport {
  const org = registry.get(orgId);
  const { events } = ingestEvents(raw, registry);
  const orgEvents = events.filter((e) => e.orgId === orgId);
  return buildReportFromNormalized(orgEvents, org, options);
}

/** Builds reports for every registered org that has at least one event. */
export function generateAllReports(
  raw: RawEvent[],
  registry: OrgRegistry,
  options: ReportOptions = {},
): Map<string, OrgReport> {
  const { events } = ingestEvents(raw, registry);
  const byOrg = groupBy(events, (e) => e.orgId);
  const out = new Map<string, OrgReport>();
  for (const [orgId, orgEvents] of byOrg) {
    const org = registry.get(orgId);
    out.set(orgId, buildReportFromNormalized(orgEvents, org, options));
  }
  return out;
}

function buildReportFromNormalized(
  events: NormalizedEvent[],
  org: Org,
  options: ReportOptions,
): OrgReport {
  const sessions = buildSessions(events, org, {
    sessionGapMs: options.sessionGapMs,
  });
  const bySessionDay = sessionsByDay(sessions);
  const agg = aggregateDaily(events, org);

  // The row set covers every day that has either activity or a session.
  const dayKeys = new Set<string>(aggregateDayKeys(agg));
  for (const day of bySessionDay.keys()) {
    dayKeys.add(day);
  }

  let rows: DailyRow[] = [...dayKeys].sort().map((day) => ({
    day,
    activeUsers: activeUsersOn(agg, day).size,
    sessionCount: bySessionDay.get(day)?.length ?? 0,
    eventCount: agg.eventCountByDay.get(day) ?? 0,
  }));

  if (options.fromDay) {
    rows = rows.filter((r) => compareDayKeys(r.day, options.fromDay!) >= 0);
  }
  if (options.toDay) {
    rows = rows.filter((r) => compareDayKeys(r.day, options.toDay!) <= 0);
  }

  return {
    orgId: org.id,
    rows,
    weekly: rollupWeekly(rows, org),
  };
}

/** Finds a row by day key, or null. */
export function rowForDay(report: OrgReport, dayKey: string): DailyRow | null {
  return report.rows.find((r) => r.day === dayKey) ?? null;
}

/** Total active-user-days across the whole report. */
export function totalActiveUserDays(report: OrgReport): number {
  return report.rows.reduce((acc, r) => acc + r.activeUsers, 0);
}
