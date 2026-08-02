/**
 * nextRun(expr, after) — compute the next UTC instant at which a 5-field cron
 * expression fires, strictly after the given Date.
 *
 * Expression format (fields separated by whitespace):
 *
 *     minute hour day-of-month month day-of-week
 *
 * Field value ranges:
 *   - minute:       0-59
 *   - hour:         0-23
 *   - day-of-month: 1-31
 *   - month:        1-12   (1 = January)
 *   - day-of-week:  0-6    (0 = Sunday, 6 = Saturday; 7 is NOT accepted)
 *
 * Per-field syntax (any field may use any of these):
 *   - "*"      every value in the field's range
 *   - "N"      a single value, e.g. "5"
 *   - "A-B"    inclusive ascending range, e.g. "9-17" (A <= B required; no wrap-around)
 *   - "*"/S    i.e. "*\/S": every S-th value starting at the field's minimum,
 *              e.g. "*\/15" for minutes = 0,15,30,45
 *   - "A-B/S"  every S-th value starting at A, not exceeding B,
 *              e.g. "10-30/5" = 10,15,20,25,30
 *   - comma list combining any of the above, e.g. "5,35" or "1-3,10,20-30/5"
 *
 * day-of-month / day-of-week interaction (standard cron OR-semantics):
 *   - A field is "restricted" iff it is anything other than a bare "*"
 *     (so "*\/2" counts as restricted).
 *   - If BOTH dom and dow are restricted, a day matches when EITHER field
 *     matches it.
 *   - If exactly one of them is restricted, that one must match.
 *   - If neither is restricted, every day matches.
 *   All other fields (minute, hour, month) always combine with AND.
 *
 * Semantics:
 *   - All computation is in UTC. Local timezones and DST never apply.
 *   - Granularity is one minute. The returned Date always has seconds and
 *     milliseconds equal to 0.
 *   - "Strictly after": the result is the earliest minute boundary T such that
 *     T > after AND T matches the expression. If `after` itself lies exactly on
 *     a matching minute boundary, the result is the NEXT match, not `after`.
 *     (E.g. expr "*\/15 * * * *" with after = 10:15:00.000Z returns 10:30:00.000Z.)
 *   - Month lengths and leap years follow the real (proleptic Gregorian, as
 *     implemented by JavaScript Date UTC functions) calendar; e.g. "0 0 29 2 *"
 *     only fires on Feb 29 of leap years.
 *
 * Errors — throw a plain Error for malformed input:
 *   - wrong number of fields (must be exactly 5)
 *   - non-numeric tokens, values outside the field's range
 *   - ranges with A > B, steps <= 0
 *   Also throw an Error if no matching time exists within 5 years after
 *   `after` (this bounds the search; valid expressions used in the tests
 *   always match within that horizon).
 *
 * @param expr  5-field cron expression as described above
 * @param after exclusive lower bound for the search
 * @returns     next matching Date (UTC), strictly after `after`
 */
export function nextRun(expr: string, after: Date): Date {
  throw new Error("not implemented");
}
