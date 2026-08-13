/**
 * Tiny query-string utilities. The pipeline stores the raw path (including
 * any query) on the request; handlers that care about query parameters use
 * these helpers rather than depending on a URL polyfill.
 */

/** Parse `?a=1&b=two` (with or without leading `?`) into a flat record. */
export function parseQuery(pathOrQuery: string): Record<string, string> {
  const qIndex = pathOrQuery.indexOf("?");
  const raw = qIndex >= 0 ? pathOrQuery.slice(qIndex + 1) : pathOrQuery.startsWith("?") ? pathOrQuery.slice(1) : "";
  const out: Record<string, string> = {};
  if (raw.length === 0) return out;
  for (const pair of raw.split("&")) {
    if (pair.length === 0) continue;
    const eq = pair.indexOf("=");
    const key = eq >= 0 ? pair.slice(0, eq) : pair;
    const value = eq >= 0 ? pair.slice(eq + 1) : "";
    try {
      out[decodeURIComponent(key)] = decodeURIComponent(value.replace(/\+/g, " "));
    } catch {
      // Malformed percent-encoding: keep the raw bytes rather than throwing
      // in the middle of request handling.
      out[key] = value;
    }
  }
  return out;
}

/** Read an integer query parameter with bounds and a default. */
export function intParam(
  query: Record<string, string>,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = query[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** Serialize a record back into a canonical, key-sorted query string. */
export function formatQuery(params: Record<string, string>): string {
  const keys = Object.keys(params).sort();
  if (keys.length === 0) return "";
  return (
    "?" +
    keys
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k]!)}`)
      .join("&")
  );
}
