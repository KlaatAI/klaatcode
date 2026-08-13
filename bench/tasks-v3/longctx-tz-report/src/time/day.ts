/**
 * Day-bucketing utilities.
 *
 * Every analytics module in this codebase buckets timestamps into
 * "org-local calendar days". An org has a fixed UTC offset expressed in
 * minutes (e.g. +330 for IST, -480 for US Pacific standard). We do not
 * model DST transitions: orgs pick a fixed offset and all reporting is
 * relative to it. This keeps the math pure and machine-independent —
 * no locale-dependent Date behavior, UTC arithmetic only.
 *
 * The canonical helper is {@link localDayKey}. Anything that groups
 * events, sessions or rows by day MUST go through it (or through
 * {@link localWeekKey}, which composes it).
 */

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Returns the org-local calendar day for a UTC timestamp, formatted as
 * "YYYY-MM-DD".
 *
 * The timestamp is shifted by the org's fixed offset and then read with
 * UTC accessors, so the result is deterministic regardless of the host
 * machine's timezone.
 */
export function localDayKey(tsMs: number, offsetMinutes: number): string {
  const shifted = new Date(tsMs + offsetMinutes * MINUTE_MS);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(
    shifted.getUTCDate(),
  )}`;
}

/**
 * Returns the number of whole local days since the Unix epoch for the
 * given timestamp and offset. Useful for cheap day arithmetic.
 */
export function localDayNumber(tsMs: number, offsetMinutes: number): number {
  return Math.floor((tsMs + offsetMinutes * MINUTE_MS) / DAY_MS);
}

/**
 * Returns the local week key ("YYYY-Www" style is overkill here; we use
 * the day key of the Monday that starts the week) for a timestamp.
 * Weeks start on Monday in org-local time.
 */
export function localWeekKey(tsMs: number, offsetMinutes: number): string {
  const dayNum = localDayNumber(tsMs, offsetMinutes);
  // 1970-01-01 was a Thursday; Monday of that week is day number -3.
  const dowFromMonday = ((dayNum + 3) % 7 + 7) % 7;
  const mondayDayNum = dayNum - dowFromMonday;
  const mondayUtcMs = mondayDayNum * DAY_MS - offsetMinutes * MINUTE_MS;
  return localDayKey(mondayUtcMs, offsetMinutes);
}

/** Week key for an already-computed day key (org offset required). */
export function weekKeyForDayKey(dayKey: string, offsetMinutes: number): string {
  const startUtc = dayKeyToUtcStart(dayKey, offsetMinutes);
  return localWeekKey(startUtc, offsetMinutes);
}

/**
 * Inverse of {@link localDayKey}: the UTC timestamp at which the given
 * local day begins (local midnight expressed in UTC ms).
 */
export function dayKeyToUtcStart(dayKey: string, offsetMinutes: number): number {
  const parsed = parseDayKey(dayKey);
  const utcMidnight = Date.UTC(parsed.year, parsed.month - 1, parsed.day);
  return utcMidnight - offsetMinutes * MINUTE_MS;
}

/** Exclusive UTC end of the given local day. */
export function dayKeyToUtcEnd(dayKey: string, offsetMinutes: number): number {
  return dayKeyToUtcStart(dayKey, offsetMinutes) + DAY_MS;
}

export interface ParsedDayKey {
  year: number;
  month: number;
  day: number;
}

/** Parses "YYYY-MM-DD"; throws on malformed input. */
export function parseDayKey(dayKey: string): ParsedDayKey {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!m) {
    throw new Error(`invalid day key: ${JSON.stringify(dayKey)}`);
  }
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/** Lexicographic comparison works for ISO day keys, but be explicit. */
export function compareDayKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Adds `n` calendar days to a day key (n may be negative). */
export function addDaysToKey(dayKey: string, n: number): string {
  const p = parseDayKey(dayKey);
  const utc = Date.UTC(p.year, p.month - 1, p.day) + n * DAY_MS;
  // Offset 0 is correct here: the intermediate value is already a plain
  // calendar date, not an instant.
  return localDayKey(utc, 0);
}

/** Inclusive list of day keys between two keys (both ends included). */
export function dayKeyRange(fromKey: string, toKey: string): string[] {
  if (compareDayKeys(fromKey, toKey) > 0) {
    return [];
  }
  const out: string[] = [];
  let cur = fromKey;
  while (compareDayKeys(cur, toKey) <= 0) {
    out.push(cur);
    cur = addDaysToKey(cur, 1);
    if (out.length > 10_000) {
      throw new Error("dayKeyRange: range too large");
    }
  }
  return out;
}
