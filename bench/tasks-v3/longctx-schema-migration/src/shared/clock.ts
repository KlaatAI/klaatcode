/** Injectable clock so services stay deterministic under test. */
export interface Clock {
  now(): Date;
}

/** A clock frozen at a fixed instant. */
export class FixedClock implements Clock {
  private readonly at: number;

  constructor(at: Date | string) {
    this.at = typeof at === "string" ? Date.parse(at) : at.getTime();
    if (Number.isNaN(this.at)) {
      throw new Error(`FixedClock: invalid instant ${String(at)}`);
    }
  }

  now(): Date {
    return new Date(this.at);
  }
}

/** Wall-clock implementation used by production wiring. */
export const systemClock: Clock = {
  now: () => new Date(),
};

/** Hour-of-day (0-23) in UTC for the given clock reading. */
export function utcHour(clock: Clock): number {
  return clock.now().getUTCHours();
}
