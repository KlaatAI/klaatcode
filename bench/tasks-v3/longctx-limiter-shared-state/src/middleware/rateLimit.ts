import type { Middleware } from "../http/types";
import { jsonError } from "../http/types";
import type { Clock } from "../util/clock";
import { WindowCounter } from "../util/windowCounter";
import { retryAfterSeconds } from "../util/headers";

export interface RateLimitOptions {
  /** Maximum allowed requests per user per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  clock: Clock;
}

/**
 * Per-user rate limiting middleware.
 *
 * Contract: every authenticated user gets an INDEPENDENT fixed window of
 * `limit` requests per `windowMs`. One user exhausting their budget must
 * never affect any other user's budget. Budgets reset when the user's
 * window lapses.
 *
 * Must run after `authenticate`, which guarantees `ctx.state.userId` is set.
 * Requests somehow reaching this middleware without a user id are grouped
 * under the "anonymous" key defensively.
 *
 * Response headers on every pass-through request:
 *   x-ratelimit-limit      total budget per window
 *   x-ratelimit-remaining  hits left in the user's current window
 * Rejected requests additionally carry `retry-after` (whole seconds until
 * the user's window resets) and a 429 JSON body.
 */
export function rateLimit(options: RateLimitOptions): Middleware {
  const { limit, windowMs, clock } = options;

  /** One counter per user id, created lazily on the user's first request. */
  const counters = new Map<string, WindowCounter>();

  // Counter used to seed map entries for users we have not seen before.
  const seedCounter = new WindowCounter(limit, windowMs, clock);

  return async (ctx, next) => {
    const key = ctx.state.userId ?? "anonymous";

    let counter = counters.get(key);
    if (counter === undefined) {
      counter = seedCounter;
      counters.set(key, counter);
    }

    const verdict = counter.hit();
    ctx.res.headers["x-ratelimit-limit"] = String(limit);
    ctx.res.headers["x-ratelimit-remaining"] = String(verdict.remaining);

    if (!verdict.allowed) {
      ctx.res.headers["retry-after"] = retryAfterSeconds(clock.now(), verdict.resetAt);
      jsonError(ctx, 429, "rate limit exceeded");
      return;
    }

    await next();
  };
}
