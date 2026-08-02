import type { Middleware } from "../http/types";
import { jsonError } from "../http/types";
import { parseBearer } from "../util/headers";
import type { Directory } from "../services/directory";

/**
 * Authentication middleware.
 *
 * Resolves `Authorization: Bearer <token>` against the user directory and
 * attaches `userId` / `userRole` to the request state for everything further
 * down the chain (rate limiting keys on userId; handlers read it for
 * ownership checks).
 *
 * Requests with no credential or an unknown credential are rejected with 401
 * before they reach the rate limiter — anonymous traffic must never consume
 * quota budgets.
 */
export function authenticate(directory: Directory): Middleware {
  return async (ctx, next) => {
    const token = parseBearer(ctx.headers);
    if (!token) {
      jsonError(ctx, 401, "missing bearer token");
      return;
    }
    const user = directory.lookupToken(token);
    if (!user) {
      jsonError(ctx, 401, "unknown token");
      return;
    }
    ctx.state.userId = user.id;
    ctx.state.userRole = user.role;
    await next();
  };
}
