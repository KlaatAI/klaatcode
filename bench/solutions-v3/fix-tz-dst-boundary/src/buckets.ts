const DAY_MS = 86_400_000;

/**
 * Groups epoch-millisecond timestamps into local calendar days for a fixed
 * UTC offset.
 *
 * `utcOffsetMinutes` is minutes east of UTC (e.g. +330 for India, -300 for
 * New York in winter, -570 for the Marquesas). Returns a Map from the local
 * date key "YYYY-MM-DD" to the timestamps falling on that local day, with
 * each bucket's timestamps in ascending order. Uses pure UTC arithmetic —
 * results never depend on the machine's timezone.
 */
export function dailyBuckets(
  timestampsMs: number[],
  utcOffsetMinutes: number,
): Map<string, number[]> {
  const buckets = new Map<string, number[]>();
  const sorted = [...timestampsMs].sort((a, b) => a - b);
  for (const ts of sorted) {
    const key = localDayKey(ts, utcOffsetMinutes);
    const list = buckets.get(key);
    if (list) list.push(ts);
    else buckets.set(key, [ts]);
  }
  return buckets;
}

function localDayKey(ts: number, utcOffsetMinutes: number): string {
  // Local wall-clock time is the UTC instant plus the zone offset; shifting
  // by +offset lets day arithmetic be done with plain UTC division.
  const shifted = ts + utcOffsetMinutes * 60_000;
  const dayIndex = Math.floor(shifted / DAY_MS);
  const canonical = new Date(dayIndex * DAY_MS);
  return canonical.toISOString().slice(0, 10);
}
