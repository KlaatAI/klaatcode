/**
 * Incremental scanner for a stream of whitespace-separated JSON values.
 *
 * The logical input is a sequence of zero or more JSON values (any JSON type:
 * object, array, string, number, true, false, null) separated by whitespace
 * (space, tab, `\n`, `\r`). The stream is delivered via successive
 * `feed(chunk)` calls, and chunk boundaries are ARBITRARY: a boundary may fall
 * inside a string, in the middle of an escape sequence (between `\` and `"`),
 * between the digits of a number, or in the middle of `true`/`false`/`null`.
 *
 * Contract:
 *
 * - `feed(chunk)` consumes the chunk and returns an array (possibly empty) of
 *   every value COMPLETED by this chunk, in stream order, parsed exactly as
 *   `JSON.parse` would parse the value's text.
 * - A string value is complete at its closing unescaped `"`. Escape sequences
 *   (`\"`, `\\`, and the other JSON escapes) must be tracked correctly even
 *   when a chunk boundary splits them (e.g. one chunk ends with `"a\` and the
 *   next begins with `"b"` — that is the single string `a"b`).
 * - An object or array value is complete when its top-level bracket/brace
 *   closes. Braces, brackets, and quotes appearing INSIDE nested strings must
 *   not confuse the depth tracking (e.g. `{"a":"}{"}` is one object).
 * - A number or bare literal (`true`, `false`, `null`) is complete ONLY once a
 *   whitespace character is seen after it, because its end is otherwise
 *   unknowable (`12` may be continued by a later chunk `3` to form `123`).
 * - Strings, objects, and arrays are self-delimiting: they are emitted
 *   immediately at their final character without waiting for whitespace.
 * - Whitespace-only or empty chunks simply return `[]`.
 * - Feeding the same document in one chunk, split at any index into two
 *   chunks, or one character at a time must yield the identical sequence of
 *   values.
 * - `end()` signals end-of-stream. It throws an `Error` if any
 *   partially-buffered value remains: an unterminated string, an unbalanced
 *   object/array, a partial literal (e.g. `tru`), or a number/literal that has
 *   not yet been terminated by whitespace (a trailing `42` with no following
 *   whitespace is incomplete by definition). Otherwise it returns normally.
 *   Calling `feed` after `end()` is not required to work (it may throw).
 *
 * Suggested implementation approach: keep a buffer plus persistent scan state
 * (current mode idle/string/container/primitive, bracket depth, in-string
 * flag, escape flag) across `feed` calls; when a value's end is detected,
 * `JSON.parse` the buffered slice and emit it.
 */
export class JsonValueScanner {
  /**
   * Consume the next chunk of the stream and return all values completed by
   * it (possibly an empty array), in order.
   */
  feed(chunk: string): unknown[] {
    throw new Error("not implemented");
  }

  /**
   * Signal end-of-stream. Throws an Error if a partially-buffered value
   * remains (unterminated string, unbalanced container, partial literal, or a
   * number/literal not yet terminated by whitespace).
   */
  end(): void {
    throw new Error("not implemented");
  }
}
