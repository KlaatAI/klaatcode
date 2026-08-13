/**
 * Header utilities shared by the middleware stack.
 *
 * Header names are case-insensitive per RFC 9110; internally we store and
 * look them up lower-cased. Values are kept verbatim.
 */
export type HeaderMap = Record<string, string>;

/** Lower-case every header name; last duplicate wins. */
export function normalizeHeaders(headers: HeaderMap | undefined): HeaderMap {
  const out: HeaderMap = {};
  if (!headers) return out;
  for (const [name, value] of Object.entries(headers)) {
    out[name.toLowerCase()] = value;
  }
  return out;
}

/** Case-insensitive single-header lookup. */
export function getHeader(headers: HeaderMap, name: string): string | undefined {
  const direct = headers[name];
  if (direct !== undefined) return direct;
  return headers[name.toLowerCase()];
}

/**
 * Extract the credential from an `Authorization: Bearer <token>` header.
 * Returns undefined when the header is absent or not a bearer scheme.
 */
export function parseBearer(headers: HeaderMap): string | undefined {
  const raw = getHeader(headers, "authorization");
  if (!raw) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(raw.trim());
  if (!match) return undefined;
  return match[1];
}

/** Format an epoch-ms deadline as a whole-seconds Retry-After value. */
export function retryAfterSeconds(nowMs: number, resetAtMs: number): string {
  const deltaMs = Math.max(0, resetAtMs - nowMs);
  return String(Math.ceil(deltaMs / 1000));
}
