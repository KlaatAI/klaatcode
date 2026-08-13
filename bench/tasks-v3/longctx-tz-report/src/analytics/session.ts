/**
 * Session builder.
 *
 * A session is a maximal run of one user's events where consecutive
 * events are separated by no more than `sessionGapMs`. Sessions are
 * attributed to the org-local calendar day on which they START (the
 * documented convention — a session straddling local midnight counts
 * toward its start day only).
 */

import type { NormalizedEvent, Session } from "./types";
import { DEFAULT_SESSION_GAP_MS } from "./types";
import type { Org } from "../orgs/registry";
import { localDayKey } from "../time/day";
import { groupBy, sortedBy } from "../util/collections";
import { invariant } from "../util/assert";

export interface SessionBuildOptions {
  sessionGapMs?: number;
}

/**
 * Builds sessions for a single org from that org's normalized events.
 * Events may arrive in any order; they are sorted per user first.
 */
export function buildSessions(
  events: NormalizedEvent[],
  org: Org,
  options: SessionBuildOptions = {},
): Session[] {
  const gapMs = options.sessionGapMs ?? DEFAULT_SESSION_GAP_MS;
  invariant(gapMs > 0, "sessionGapMs must be positive");

  const sessions: Session[] = [];
  const byUser = groupBy(events, (e) => e.userId);

  for (const [userId, userEvents] of byUser) {
    const ordered = sortedBy(userEvents, (e) => e.timestamp);

    let current: Session | null = null;
    for (const event of ordered) {
      invariant(
        event.orgId === org.id,
        `event org ${event.orgId} does not match ${org.id}`,
      );

      if (current !== null && event.timestamp - current.endMs <= gapMs) {
        // Extend the open session.
        current.endMs = event.timestamp;
        current.eventCount++;
        continue;
      }

      if (current !== null) {
        sessions.push(current);
      }
      current = {
        orgId: org.id,
        userId,
        startMs: event.timestamp,
        endMs: event.timestamp,
        eventCount: 1,
        // Attribute to the org-local day of the first event.
        dayKey: localDayKey(event.timestamp, org.utcOffsetMinutes),
      };
    }

    if (current !== null) {
      sessions.push(current);
    }
  }

  // Deterministic output order: by start time, then user id.
  return sessions.sort((a, b) => {
    if (a.startMs !== b.startMs) {
      return a.startMs - b.startMs;
    }
    return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
  });
}

/** Sessions grouped by their (org-local) start day. */
export function sessionsByDay(sessions: Session[]): Map<string, Session[]> {
  return groupBy(sessions, (s) => s.dayKey);
}

/** Mean session duration in ms, 0 for an empty list. */
export function meanSessionDurationMs(sessions: Session[]): number {
  if (sessions.length === 0) {
    return 0;
  }
  let total = 0;
  for (const s of sessions) {
    total += s.endMs - s.startMs;
  }
  return total / sessions.length;
}

/** Longest session, or null for an empty list. */
export function longestSession(sessions: Session[]): Session | null {
  let best: Session | null = null;
  for (const s of sessions) {
    if (best === null || s.endMs - s.startMs > best.endMs - best.startMs) {
      best = s;
    }
  }
  return best;
}
