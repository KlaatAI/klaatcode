/**
 * Minimal HTTP-ish request/response shapes used by the in-process API
 * layer. There is no real network here; the router dispatches directly.
 */

export interface ApiRequest {
  /** Route name, e.g. "projects.archive". */
  route: string;
  /** Route parameters (ids etc.). */
  params: Record<string, string>;
  /** Body for mutations. */
  body?: Record<string, unknown>;
}

export interface ApiResponse {
  status: number;
  body?: unknown;
  error?: string;
}

export function ok(body: unknown): ApiResponse {
  return { status: 200, body };
}

export function created(body: unknown): ApiResponse {
  return { status: 201, body };
}

export function forbidden(detail: string): ApiResponse {
  return { status: 403, error: `forbidden: ${detail}` };
}

export function notFound(detail: string): ApiResponse {
  return { status: 404, error: `not found: ${detail}` };
}

export function badRequest(detail: string): ApiResponse {
  return { status: 400, error: `bad request: ${detail}` };
}

/** Narrow helper: required string param or a 400. */
export function requireParam(
  req: ApiRequest,
  name: string,
): { ok: true; value: string } | { ok: false; response: ApiResponse } {
  const value = req.params[name];
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, response: badRequest(`missing param ${name}`) };
  }
  return { ok: true, value };
}
