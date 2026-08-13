/**
 * HTTP status helpers used by services and middleware when composing
 * responses and by the metrics collector when bucketing outcomes.
 */
export const STATUS_TEXT: Record<number, string> = {
  200: "OK",
  201: "Created",
  204: "No Content",
  301: "Moved Permanently",
  304: "Not Modified",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
};

/** Human-readable reason phrase; falls back to the numeric class. */
export function statusText(code: number): string {
  const known = STATUS_TEXT[code];
  if (known) return known;
  if (code >= 500) return "Server Error";
  if (code >= 400) return "Client Error";
  if (code >= 300) return "Redirection";
  if (code >= 200) return "Success";
  return "Informational";
}

/** Coarse class used for metrics bucketing: "2xx", "4xx", ... */
export function statusClass(code: number): string {
  return `${Math.floor(code / 100)}xx`;
}

export function isSuccess(code: number): boolean {
  return code >= 200 && code < 300;
}

export function isClientError(code: number): boolean {
  return code >= 400 && code < 500;
}

export function isServerError(code: number): boolean {
  return code >= 500 && code < 600;
}

/** Statuses that indicate the request may be retried safely by clients. */
export function isRetryable(code: number): boolean {
  return code === 429 || code === 502 || code === 503;
}
