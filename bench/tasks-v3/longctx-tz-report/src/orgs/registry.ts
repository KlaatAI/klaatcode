/**
 * Org registry.
 *
 * Orgs carry a fixed UTC offset (minutes east of UTC) that all analytics
 * bucketing is relative to. Offsets are validated to be whole minutes in
 * the range [-14h, +14h], matching real-world offsets.
 */

export interface Org {
  id: string;
  name: string;
  /**
   * Fixed offset from UTC in minutes (east positive). Examples:
   *   +330  => UTC+05:30 (India)
   *   -480  => UTC-08:00 (US Pacific, standard time)
   *      0  => UTC
   */
  utcOffsetMinutes: number;
  /** Plan tier; only used for report annotations. */
  plan: "free" | "team" | "enterprise";
}

const MIN_OFFSET = -14 * 60;
const MAX_OFFSET = 14 * 60;

export function validateOrg(org: Org): void {
  if (!org.id || typeof org.id !== "string") {
    throw new Error("org id must be a non-empty string");
  }
  const off = org.utcOffsetMinutes;
  if (!Number.isInteger(off)) {
    throw new Error(`org ${org.id}: utcOffsetMinutes must be an integer`);
  }
  if (off < MIN_OFFSET || off > MAX_OFFSET) {
    throw new Error(
      `org ${org.id}: utcOffsetMinutes ${off} outside [${MIN_OFFSET}, ${MAX_OFFSET}]`,
    );
  }
}

/** In-memory registry keyed by org id. */
export class OrgRegistry {
  private readonly orgs = new Map<string, Org>();

  constructor(initial: Org[] = []) {
    for (const org of initial) {
      this.register(org);
    }
  }

  register(org: Org): void {
    validateOrg(org);
    if (this.orgs.has(org.id)) {
      throw new Error(`duplicate org id: ${org.id}`);
    }
    this.orgs.set(org.id, { ...org });
  }

  get(orgId: string): Org {
    const org = this.orgs.get(orgId);
    if (!org) {
      throw new Error(`unknown org: ${orgId}`);
    }
    return org;
  }

  has(orgId: string): boolean {
    return this.orgs.has(orgId);
  }

  /** All orgs in registration order. */
  all(): Org[] {
    return [...this.orgs.values()];
  }

  /** Formats an offset like "+05:30" / "-08:00" for display. */
  static formatOffset(offsetMinutes: number): string {
    const sign = offsetMinutes < 0 ? "-" : "+";
    const abs = Math.abs(offsetMinutes);
    const h = Math.floor(abs / 60);
    const m = abs % 60;
    const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
    return `${sign}${pad(h)}:${pad(m)}`;
  }
}
