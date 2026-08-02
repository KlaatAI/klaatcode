/**
 * Injectable clock.
 *
 * Nothing in the repository layer may call `Date.now()` directly; a clock is
 * threaded through the service so tests are fully deterministic. Timestamps
 * are plain epoch-millisecond numbers throughout the codebase.
 */

export interface Clock {
  now(): number;
}

/** A clock that always returns the same instant. */
export class FixedClock implements Clock {
  constructor(private readonly instant: number) {}

  now(): number {
    return this.instant;
  }
}

/**
 * A clock that starts at `start` and advances by `stepMs` every time it is
 * read. Handy for generating strictly increasing timestamps in fixtures.
 */
export class SteppingClock implements Clock {
  private current: number;

  constructor(start: number, private readonly stepMs: number = 1) {
    this.current = start;
  }

  now(): number {
    const value = this.current;
    this.current += this.stepMs;
    return value;
  }

  /** Jumps the clock forward without producing a reading. */
  advance(byMs: number): void {
    if (byMs < 0) {
      throw new RangeError("clocks only move forward");
    }
    this.current += byMs;
  }
}

/** Production default. Not used by tests. */
export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}
