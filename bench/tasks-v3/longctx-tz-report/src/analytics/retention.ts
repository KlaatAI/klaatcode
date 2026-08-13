/**
 * Retention cohorts (distractor for the daily report, but a real
 * consumer of the same bucketing convention).
 *
 * A user's cohort day is the org-local day of their FIRST event. The
 * retention matrix counts, for each cohort day, how many of that
 * cohort's users were active again N days later.
 */

import type { NormalizedEvent } from "./types";
import type { Org } from "../orgs/registry";
import { localDayKey, addDaysToKey, compareDayKeys } from "../time/day";
import { groupBy, sortedBy } from "../util/collections";

export interface RetentionCell {
  cohortDay: string;
  dayOffset: number;
  returned: number;
  cohortSize: number;
}

export interface RetentionMatrix {
  cohorts: Map<string, Set<string>>;
  cells: RetentionCell[];
}

/**
 * Builds a retention matrix for the org up to `maxOffsetDays` offsets.
 */
export function buildRetention(
  events: NormalizedEvent[],
  org: Org,
  maxOffsetDays = 7,
): RetentionMatrix {
  const byUser = groupBy(events, (e) => e.userId);

  // Cohort assignment: local day of first event.
  const cohorts = new Map<string, Set<string>>();
  const activeDaysByUser = new Map<string, Set<string>>();

  for (const [userId, userEvents] of byUser) {
    const ordered = sortedBy(userEvents, (e) => e.timestamp);
    const first = ordered[0]!;
    const cohortDay = localDayKey(first.timestamp, org.utcOffsetMinutes);

    let cohort = cohorts.get(cohortDay);
    if (!cohort) {
      cohort = new Set();
      cohorts.set(cohortDay, cohort);
    }
    cohort.add(userId);

    const activeDays = new Set<string>();
    for (const e of ordered) {
      activeDays.add(localDayKey(e.timestamp, org.utcOffsetMinutes));
    }
    activeDaysByUser.set(userId, activeDays);
  }

  const cells: RetentionCell[] = [];
  const cohortDays = [...cohorts.keys()].sort(compareDayKeys);

  for (const cohortDay of cohortDays) {
    const members = cohorts.get(cohortDay)!;
    for (let offset = 1; offset <= maxOffsetDays; offset++) {
      const targetDay = addDaysToKey(cohortDay, offset);
      let returned = 0;
      for (const userId of members) {
        if (activeDaysByUser.get(userId)?.has(targetDay)) {
          returned++;
        }
      }
      cells.push({
        cohortDay,
        dayOffset: offset,
        returned,
        cohortSize: members.size,
      });
    }
  }

  return { cohorts, cells };
}

/** Retention rate for a specific cohort/offset, or null if unknown. */
export function retentionRate(
  matrix: RetentionMatrix,
  cohortDay: string,
  dayOffset: number,
): number | null {
  const cell = matrix.cells.find(
    (c) => c.cohortDay === cohortDay && c.dayOffset === dayOffset,
  );
  if (!cell || cell.cohortSize === 0) {
    return null;
  }
  return cell.returned / cell.cohortSize;
}
