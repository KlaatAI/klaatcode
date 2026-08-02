/**
 * Self-contained base64url codec.
 *
 * Cursors are handed to API clients, so they must survive URLs unmodified.
 * We therefore use the base64url alphabet (RFC 4648 §5: `-` and `_` instead
 * of `+` and `/`) and omit padding. Implemented by hand so the codec has no
 * runtime dependencies and behaves identically everywhere.
 */

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const REVERSE: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i++) {
  REVERSE[ALPHABET[i]!] = i;
}

/** Encodes a UTF-8 string as unpadded base64url. */
export function encodeBase64Url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    const triple = (b0 << 16) | (b1 << 8) | b2;
    out += ALPHABET[(triple >> 18) & 0x3f]!;
    out += ALPHABET[(triple >> 12) & 0x3f]!;
    if (i + 1 < bytes.length) out += ALPHABET[(triple >> 6) & 0x3f]!;
    if (i + 2 < bytes.length) out += ALPHABET[triple & 0x3f]!;
  }
  return out;
}

export class Base64DecodeError extends Error {
  constructor(detail: string) {
    super(`invalid base64url input: ${detail}`);
    this.name = "Base64DecodeError";
  }
}

/** Decodes unpadded base64url back into a UTF-8 string. */
export function decodeBase64Url(input: string): string {
  if (input.length % 4 === 1) {
    throw new Base64DecodeError("impossible length");
  }
  const bytes: number[] = [];
  let buffer = 0;
  let bitsHeld = 0;
  for (const ch of input) {
    const value = REVERSE[ch];
    if (value === undefined) {
      throw new Base64DecodeError(`unexpected character "${ch}"`);
    }
    buffer = (buffer << 6) | value;
    bitsHeld += 6;
    if (bitsHeld >= 8) {
      bitsHeld -= 8;
      bytes.push((buffer >> bitsHeld) & 0xff);
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** Round-trip helper used by diagnostics and property checks. */
export function base64UrlRoundTrips(input: string): boolean {
  return decodeBase64Url(encodeBase64Url(input)) === input;
}
