/**
 * nextRun(expr, after) — compute the next UTC instant at which a 5-field cron
 * expression fires, strictly after the given Date.
 *
 * Fields: minute(0-59) hour(0-23) dom(1-31) month(1-12) dow(0-6, 0=Sunday).
 * Syntax per field: "*", "N", "A-B", "*\/S", "A-B/S", comma lists.
 * dom/dow OR-semantics when both restricted. UTC only, minute granularity,
 * seconds/ms zero, strictly after `after`. Throws Error on malformed input or
 * when no match exists within 5 years.
 */
export function nextRun(expr: string, after: Date): Date {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron expression must have exactly 5 fields, got ${fields.length}`);
  }
  const minute = parseField(fields[0], 0, 59);
  const hour = parseField(fields[1], 0, 23);
  const dom = parseField(fields[2], 1, 31);
  const month = parseField(fields[3], 1, 12);
  const dow = parseField(fields[4], 0, 6);
  const domRestricted = fields[2] !== "*";
  const dowRestricted = fields[4] !== "*";

  const dayMatches = (t: Date): boolean => {
    const domOk = dom.has(t.getUTCDate());
    const dowOk = dow.has(t.getUTCDay());
    if (domRestricted && dowRestricted) return domOk || dowOk;
    if (domRestricted) return domOk;
    if (dowRestricted) return dowOk;
    return true;
  };

  // First candidate: the minute boundary strictly after `after`.
  let t = new Date(
    Date.UTC(
      after.getUTCFullYear(),
      after.getUTCMonth(),
      after.getUTCDate(),
      after.getUTCHours(),
      after.getUTCMinutes(),
    ) + 60_000,
  );

  const limit = after.getTime() + 5 * 366 * 24 * 3600 * 1000;
  while (t.getTime() <= limit) {
    if (!month.has(t.getUTCMonth() + 1)) {
      // jump to the first minute of the next month
      t = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 1));
      continue;
    }
    if (!dayMatches(t)) {
      // jump to midnight of the next day
      t = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 1));
      continue;
    }
    if (!hour.has(t.getUTCHours())) {
      // jump to the top of the next hour
      t = new Date(
        Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), t.getUTCHours() + 1),
      );
      continue;
    }
    if (!minute.has(t.getUTCMinutes())) {
      t = new Date(t.getTime() + 60_000);
      continue;
    }
    return t;
  }
  throw new Error("no matching time within 5 years of the given date");
}

function parseField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  if (field.length === 0) throw new Error("empty cron field");
  for (const part of field.split(",")) {
    let m: RegExpMatchArray | null;
    if (part === "*") {
      addRange(out, min, max, 1, min, max);
    } else if ((m = part.match(/^\*\/(\d+)$/))) {
      addRange(out, min, max, toStep(m[1]), min, max);
    } else if ((m = part.match(/^(\d+)-(\d+)\/(\d+)$/))) {
      addRange(out, toNum(m[1], min, max), toNum(m[2], min, max), toStep(m[3]), min, max);
    } else if ((m = part.match(/^(\d+)-(\d+)$/))) {
      addRange(out, toNum(m[1], min, max), toNum(m[2], min, max), 1, min, max);
    } else if (/^\d+$/.test(part)) {
      out.add(toNum(part, min, max));
    } else {
      throw new Error(`malformed cron field part: "${part}"`);
    }
  }
  return out;
}

function toNum(s: string, min: number, max: number): number {
  const n = parseInt(s, 10);
  if (n < min || n > max) throw new Error(`cron value ${n} out of range ${min}-${max}`);
  return n;
}

function toStep(s: string): number {
  const n = parseInt(s, 10);
  if (n <= 0) throw new Error(`cron step must be positive, got ${n}`);
  return n;
}

function addRange(
  out: Set<number>,
  a: number,
  b: number,
  step: number,
  min: number,
  max: number,
): void {
  if (a > b) throw new Error(`cron range ${a}-${b} is descending`);
  if (a < min || b > max) throw new Error(`cron range ${a}-${b} out of ${min}-${max}`);
  for (let v = a; v <= b; v += step) out.add(v);
}
