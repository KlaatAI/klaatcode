/**
 * Clock abstraction so that every time-dependent component in the service
 * (rate limiting windows, request timing, log timestamps) can be driven
 * deterministically in tests. Production code receives a SystemClock; tests
 * inject a FakeClock and advance it manually.
 */
export interface Clock {
  /** Current time in milliseconds since the Unix epoch. */
  now(): number;
}

/** Wall-clock implementation used in production wiring. */
export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

/**
 * Deterministic clock for tests. Starts at an arbitrary fixed epoch so test
 * output is stable across machines and runs.
 */
export class FakeClock implements Clock {
  private current: number;

  constructor(startMs = 1_700_000_000_000) {
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  /** Move time forward by `ms` milliseconds. Negative values are rejected. */
  advance(ms: number): void {
    if (ms < 0) {
      throw new Error("FakeClock.advance: cannot move time backwards");
    }
    this.current += ms;
  }

  /** Jump directly to an absolute timestamp. */
  set(ms: number): void {
    if (ms < this.current) {
      throw new Error("FakeClock.set: cannot move time backwards");
    }
    this.current = ms;
  }
}
