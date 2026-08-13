/**
 * Weekly rollup: collapses DailyRow[] into WeeklyRow[] where weeks start
 * on Monday in org-local time.
 *
 * Note "activeUserDays" is the SUM of daily active counts, not distinct
 * users over the week — a user active every day of a week contributes 7.
 * This is the metric product asked for (it tracks engagement volume).
 */

import type { DailyRow, WeeklyRow } from "./types";
import type { Org } from "../orgs/registry";
import { weekKeyForDayKey } from "../time/day";

/** Groups daily rows into weekly rows for the given org. */
export function rollupWeekly(rows: DailyRow[], org: Org): WeeklyRow[] {
  const byWeek = new Map<string, WeeklyRow>();

  for (const row of rows) {
    const weekStart = weekKeyForDayKey(row.day, org.utcOffsetMinutes);
    let weekly = byWeek.get(weekStart);
    if (!weekly) {
      weekly = {
        weekStart,
        activeUserDays: 0,
        sessionCount: 0,
        eventCount: 0,
      };
      byWeek.set(weekStart, weekly);
    }
    weekly.activeUserDays += row.activeUsers;
    weekly.sessionCount += row.sessionCount;
    weekly.eventCount += row.eventCount;
  }

  return [...byWeek.values()].sort((a, b) =>
    a.weekStart < b.weekStart ? -1 : a.weekStart > b.weekStart ? 1 : 0,
  );
}

/** Sum of event counts across weekly rows (sanity/consistency checks). */
export function totalWeeklyEvents(weekly: WeeklyRow[]): number {
  let total = 0;
  for (const w of weekly) {
    total += w.eventCount;
  }
  return total;
}

/**
 * Consistency check: the weekly rollup must conserve session and event
 * totals from the daily rows it was built from. Returns a list of
 * human-readable problems (empty when consistent).
 */
export function checkRollupConservation(rows: DailyRow[], weekly: WeeklyRow[]): string[] {
  const problems: string[] = [];
  const dailySessions = rows.reduce((acc, r) => acc + r.sessionCount, 0);
  const dailyEvents = rows.reduce((acc, r) => acc + r.eventCount, 0);
  const weeklySessions = weekly.reduce((acc, w) => acc + w.sessionCount, 0);
  const weeklyEvents = totalWeeklyEvents(weekly);

  if (dailySessions !== weeklySessions) {
    problems.push(
      `session totals differ: daily=${dailySessions} weekly=${weeklySessions}`,
    );
  }
  if (dailyEvents !== weeklyEvents) {
    problems.push(`event totals differ: daily=${dailyEvents} weekly=${weeklyEvents}`);
  }
  return problems;
}
