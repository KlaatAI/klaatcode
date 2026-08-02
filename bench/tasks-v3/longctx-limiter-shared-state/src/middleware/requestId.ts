import type { Middleware } from "../http/types";

/**
 * Assigns a monotonically increasing request id and echoes it back in the
 * `x-request-id` response header. Ids are per-app-instance, which is enough
 * for correlating log lines within one process.
 */
export function requestId(): Middleware {
  let counter = 0;
  return async (ctx, next) => {
    counter += 1;
    const id = `req-${String(counter).padStart(6, "0")}`;
    ctx.state.requestId = id;
    ctx.res.headers["x-request-id"] = id;
    await next();
  };
}
