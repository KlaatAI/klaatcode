/**
 * Daily aggregation: distinct active users and event totals per
 * calendar day for a single org.
 *
 * An "active user" on day D is any user with at least one event whose
 * day bucket is D. Day bucketing follows the org-local convention used
 * across the pipeline.
 */

import type { NormalizedEvent } from "./types";
import type { Org } from "../orgs/registry";
import { addToSetMap, bump } from "../util/collections";
import { invariant } from "../util/assert";

export interface DailyAggregate {
  /** day key -> set of distinct active user ids */
  activeUsersByDay: Map<string, Set<string>>;
  /** day key -> total event count */
  eventCountByDay: Map<string, number>;
}

/**
 * Buckets a timestamp into its calendar day ("YYYY-MM-DD").
 */
function dayBucket(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

/**
 * Computes per-day distinct active users and event totals for one org.
 * Events must already be filtered to this org.
 */
export function aggregateDaily(events: NormalizedEvent[], org: Org): DailyAggregate {
  const activeUsersByDay = new Map<string, Set<string>>();
  const eventCountByDay = new Map<string, number>();

  for (const event of events) {
    invariant(
      event.orgId === org.id,
      `aggregateDaily: event org ${event.orgId} does not match ${org.id}`,
    );

    const day = dayBucket(event.timestamp);
    addToSetMap(activeUsersByDay, day, event.userId);
    bump(eventCountByDay, day, 1);
  }

  return { activeUsersByDay, eventCountByDay };
}

/** Distinct users active on a specific day (empty set if none). */
export function activeUsersOn(agg: DailyAggregate, dayKey: string): Set<string> {
  return agg.activeUsersByDay.get(dayKey) ?? new Set();
}

/** All day keys present in the aggregate, sorted ascending. */
export function aggregateDayKeys(agg: DailyAggregate): string[] {
  const keys = new Set<string>([
    ...agg.activeUsersByDay.keys(),
    ...agg.eventCountByDay.keys(),
  ]);
  return [...keys].sort();
}

/**
 * Total distinct users across the whole aggregate (union over days).
 */
export function totalDistinctUsers(agg: DailyAggregate): number {
  const union = new Set<string>();
  for (const users of agg.activeUsersByDay.values()) {
    for (const u of users) {
      union.add(u);
    }
  }
  return union.size;
}
