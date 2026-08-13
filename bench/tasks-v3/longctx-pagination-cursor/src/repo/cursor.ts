/**
 * Opaque cursor codec.
 *
 * A cursor encodes the SORT KEY of the last row the client has seen (see the
 * pagination convention in domain/models.ts). The token is versioned and
 * base64url-wrapped so clients cannot depend on its contents; only this
 * module may look inside one.
 */

import {
  Base64DecodeError,
  decodeBase64Url,
  encodeBase64Url,
} from "../util/base64";

/** Wire prefix; lets us reject tokens from other systems early. */
const CURSOR_PREFIX = "kc1_";

export interface CursorPayload {
  /** Payload schema version. */
  readonly v: 1;
  /** Sort key of the last row already delivered to the client. */
  readonly key: number | string;
}

export class InvalidCursorError extends Error {
  constructor(detail: string) {
    super(`invalid cursor: ${detail}`);
    this.name = "InvalidCursorError";
  }
}

/** Wraps a sort key into an opaque token. */
export function encodeCursor(key: number | string): string {
  const payload: CursorPayload = { v: 1, key };
  return CURSOR_PREFIX + encodeBase64Url(JSON.stringify(payload));
}

/** Unwraps an opaque token back into its payload, validating shape. */
export function decodeCursor(cursor: string): CursorPayload {
  if (typeof cursor !== "string" || !cursor.startsWith(CURSOR_PREFIX)) {
    throw new InvalidCursorError("missing prefix");
  }
  let text: string;
  try {
    text = decodeBase64Url(cursor.slice(CURSOR_PREFIX.length));
  } catch (err) {
    if (err instanceof Base64DecodeError) {
      throw new InvalidCursorError(err.message);
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new InvalidCursorError("payload is not JSON");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { v?: unknown }).v !== 1
  ) {
    throw new InvalidCursorError("unsupported payload version");
  }
  const key = (parsed as { key?: unknown }).key;
  if (typeof key !== "number" && typeof key !== "string") {
    throw new InvalidCursorError("payload key must be a number or string");
  }
  if (typeof key === "number" && !Number.isFinite(key)) {
    throw new InvalidCursorError("payload key must be finite");
  }
  return { v: 1, key };
}

/** True if the string parses as a cursor this codec produced. */
export function isWellFormedCursor(cursor: string): boolean {
  try {
    decodeCursor(cursor);
    return true;
  } catch {
    return false;
  }
}
