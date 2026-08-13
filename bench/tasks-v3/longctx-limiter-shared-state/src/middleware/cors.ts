import type { Middleware } from "../http/types";
import { getHeader } from "../util/headers";

/** Origins the API answers cross-origin requests for. */
const ALLOWED_ORIGINS = new Set([
  "https://app.example.test",
  "https://staging.example.test",
]);

/**
 * Minimal CORS middleware. Reflects the origin for allow-listed origins and
 * otherwise leaves the response untouched (browsers then block the read).
 * Preflight (OPTIONS) is not modeled by this in-process pipeline; only the
 * simple-request headers matter here.
 */
export function cors(): Middleware {
  return async (ctx, next) => {
    const origin = getHeader(ctx.headers, "origin");
    if (origin && ALLOWED_ORIGINS.has(origin)) {
      ctx.res.headers["access-control-allow-origin"] = origin;
      ctx.res.headers["vary"] = "Origin";
    }
    await next();
  };
}
