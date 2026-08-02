/**
 * Shared domain types for the analytics pipeline.
 *
 * Pipeline shape:
 *
 *   RawEvent[] --ingest--> NormalizedEvent[] --session builder--> Session[]
 *                                   |                                 |
 *                                   +---> daily aggregation <---------+
 *                                              |
 *                                              v
 *                                        DailyRow[] ---> WeeklyRow[]
 *
 * All day/week bucketing is org-local (see src/time/day.ts).
 */

/** An event exactly as delivered by an SDK or collector. Untrusted. */
export interface RawEvent {
  /** Org the event belongs to. */
  orgId: string;
  /** Stable per-user identifier within the org. */
  userId: string;
  /** Event name, e.g. "page_view", "click". */
  name: string;
  /** UTC epoch milliseconds. May be a string in legacy payloads. */
  timestamp: number | string;
  /** Optional free-form properties. */
  props?: Record<string, unknown>;
}

/** A validated, normalized event. Timestamps are UTC epoch ms. */
export interface NormalizedEvent {
  orgId: string;
  userId: string;
  name: string;
  /** UTC epoch milliseconds, always a finite number. */
  timestamp: number;
  props: Record<string, unknown>;
}

/** A contiguous run of activity for one user. */
export interface Session {
  orgId: string;
  userId: string;
  /** UTC epoch ms of first event in the session. */
  startMs: number;
  /** UTC epoch ms of last event in the session. */
  endMs: number;
  /** Number of events in the session. */
  eventCount: number;
  /**
   * Org-local calendar day the session STARTED on ("YYYY-MM-DD").
   * A session that straddles local midnight is attributed to its start
   * day; this is the documented convention.
   */
  dayKey: string;
}

/** One row of the daily-active report for a single org. */
export interface DailyRow {
  /** Org-local calendar day, "YYYY-MM-DD". */
  day: string;
  /** Count of distinct users active on that local day. */
  activeUsers: number;
  /** Number of sessions that started on that local day. */
  sessionCount: number;
  /** Total events attributed to that local day. */
  eventCount: number;
}

/** Weekly rollup row (weeks start Monday, org-local). */
export interface WeeklyRow {
  /** Day key of the Monday starting the week. */
  weekStart: string;
  /** Sum of daily active-user counts across the week (activity-days). */
  activeUserDays: number;
  /** Total sessions started during the week. */
  sessionCount: number;
  /** Total events during the week. */
  eventCount: number;
}

/** Full report for one org. */
export interface OrgReport {
  orgId: string;
  rows: DailyRow[];
  weekly: WeeklyRow[];
}

/** Options accepted by the public report API. */
export interface ReportOptions {
  /**
   * Maximum idle gap (ms) between two events before a new session is
   * started. Defaults to 30 minutes.
   */
  sessionGapMs?: number;
  /** If set, only include rows within [fromDay, toDay] inclusive. */
  fromDay?: string;
  toDay?: string;
}

export const DEFAULT_SESSION_GAP_MS = 30 * 60_000;
