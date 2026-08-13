/**
 * Injectable clock abstraction.
 *
 * Production code takes a Clock rather than calling Date.now() so tests
 * and replays are deterministic. Nothing in the analytics pipeline may
 * read wall-clock time directly.
 */

export interface Clock {
  /** Current time in UTC milliseconds since the epoch. */
  nowMs(): number;
}

/** A clock frozen at a single instant. */
export class FixedClock implements Clock {
  constructor(private readonly ms: number) {}

  nowMs(): number {
    return this.ms;
  }
}

/** A clock that can be advanced manually by tests and simulations. */
export class ManualClock implements Clock {
  private ms: number;

  constructor(startMs = 0) {
    this.ms = startMs;
  }

  nowMs(): number {
    return this.ms;
  }

  advance(deltaMs: number): void {
    if (deltaMs < 0) {
      throw new Error("ManualClock cannot move backwards");
    }
    this.ms += deltaMs;
  }

  set(ms: number): void {
    if (ms < this.ms) {
      throw new Error("ManualClock cannot move backwards");
    }
    this.ms = ms;
  }
}

/** Parses an ISO-8601 UTC string into epoch ms; throws on bad input. */
export function utcMs(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new Error(`invalid ISO timestamp: ${iso}`);
  }
  return ms;
}
