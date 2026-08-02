import type { HeaderMap } from "../util/headers";

/** Supported HTTP methods for this in-process pipeline. */
export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Minimal request shape fed into the pipeline by callers/tests. */
export interface KRequest {
  method: Method;
  path: string;
  headers?: HeaderMap;
  body?: unknown;
}

/** Response produced by handlers and middleware. */
export interface KResponse {
  status: number;
  headers: HeaderMap;
  body: unknown;
}

/**
 * Per-request context threaded through the middleware chain. Middleware
 * communicates via `state` (auth attaches the user, request-id attaches the
 * id, and so on) and mutates `res` before/after calling `next`.
 */
export interface Context {
  req: KRequest;
  /** Normalized (lower-cased) request headers. */
  headers: HeaderMap;
  res: KResponse;
  /** Cross-middleware scratch space. */
  state: {
    userId?: string;
    userRole?: string;
    requestId?: string;
    routeParams?: Record<string, string>;
    startedAt?: number;
  };
}

/** Continuation invoked by middleware to run the rest of the chain. */
export type Next = () => Promise<void>;

/** Middleware signature: inspect/mutate ctx, then (optionally) call next. */
export type Middleware = (ctx: Context, next: Next) => Promise<void>;

/** Terminal route handler. */
export type Handler = (ctx: Context) => Promise<void>;

/** Error carrying an HTTP status; the pipeline maps it onto the response. */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

/** Convenience helpers for handlers building JSON responses. */
export function jsonOk(ctx: Context, body: unknown, status = 200): void {
  ctx.res.status = status;
  ctx.res.headers["content-type"] = "application/json";
  ctx.res.body = body;
}

export function jsonError(ctx: Context, status: number, message: string): void {
  ctx.res.status = status;
  ctx.res.headers["content-type"] = "application/json";
  ctx.res.body = { error: message };
}
