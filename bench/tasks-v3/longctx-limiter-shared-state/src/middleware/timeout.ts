import type { Middleware } from "../http/types";
import { jsonError } from "../http/types";

/**
 * Deadline middleware.
 *
 * Races the downstream chain against a deadline; if the handler has not
 * settled by then the response is replaced with a 503. Because the fixture
 * pipeline is fully synchronous under a fake clock, the deadline only fires
 * for genuinely hung promises — the tests never trip it, but the production
 * wiring relies on it for slow upstream calls.
 */
export function deadline(ms: number): Middleware {
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`deadline: ms must be positive, got ${ms}`);
  }

  return async (ctx, next) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;

    const guard = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, ms);
    });

    try {
      await Promise.race([next(), guard]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    if (timedOut) {
      jsonError(ctx, 503, "deadline exceeded");
    }
  };
}
