import type { Clock } from "./clock";

/** Result of recording a hit against a window counter. */
export interface HitResult {
  /** Whether the hit was within the allowed budget. */
  allowed: boolean;
  /** How many further hits are allowed inside the current window. */
  remaining: number;
  /** Epoch ms at which the current window closes and the budget resets. */
  resetAt: number;
}

/**
 * Fixed-window counter.
 *
 * Counts events inside consecutive, non-overlapping windows of `windowMs`
 * milliseconds. The first hit after a window boundary opens a fresh window
 * anchored at the timestamp of that hit. Up to `limit` hits are allowed per
 * window; further hits are reported as not allowed but still observed (they
 * do not extend the window).
 *
 * A WindowCounter instance tracks exactly ONE independent budget. Callers
 * that need separate budgets for separate subjects (users, API keys, IPs)
 * must maintain one instance per subject.
 */
export class WindowCounter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly clock: Clock;

  private windowStart: number;
  private count: number;

  constructor(limit: number, windowMs: number, clock: Clock) {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error(`WindowCounter: limit must be a positive integer, got ${limit}`);
    }
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new Error(`WindowCounter: windowMs must be positive, got ${windowMs}`);
    }
    this.limit = limit;
    this.windowMs = windowMs;
    this.clock = clock;
    this.windowStart = Number.NEGATIVE_INFINITY;
    this.count = 0;
  }

  /** True when the current window has lapsed relative to `at`. */
  private windowExpired(at: number): boolean {
    return at - this.windowStart >= this.windowMs;
  }

  /**
   * Record one hit at the current clock time and report whether it fit the
   * budget for the active window.
   */
  hit(): HitResult {
    const at = this.clock.now();
    if (this.windowExpired(at)) {
      this.windowStart = at;
      this.count = 0;
    }
    this.count += 1;
    const allowed = this.count <= this.limit;
    const remaining = Math.max(0, this.limit - this.count);
    return {
      allowed,
      remaining,
      resetAt: this.windowStart + this.windowMs,
    };
  }

  /** Inspect state without consuming budget. */
  peek(): { used: number; remaining: number; resetAt: number } {
    const at = this.clock.now();
    if (this.windowExpired(at)) {
      return { used: 0, remaining: this.limit, resetAt: at + this.windowMs };
    }
    return {
      used: this.count,
      remaining: Math.max(0, this.limit - this.count),
      resetAt: this.windowStart + this.windowMs,
    };
  }

  /** Clear all recorded hits. Mainly useful for admin resets. */
  reset(): void {
    this.windowStart = Number.NEGATIVE_INFINITY;
    this.count = 0;
  }
}
