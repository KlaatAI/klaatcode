/**
 * Truncates a string for display without ever splitting a user-perceived
 * character (grapheme cluster).
 *
 * Contract:
 * - If the string contains at most `maxGraphemes` user-perceived characters,
 *   it is returned unchanged.
 * - Otherwise the first `maxGraphemes` user-perceived characters are kept
 *   and `ellipsis` (default "…") is appended.
 * - Emoji ZWJ sequences, regional-indicator flags, skin-tone modifiers and
 *   combining marks each count as a single character and are never broken.
 */
export function truncateDisplay(
  str: string,
  maxGraphemes: number,
  ellipsis = "…",
): string {
  // Array.from iterates by code point, so surrogate pairs (astral-plane
  // emoji, CJK extensions, etc.) are never cut in half.
  const chars = Array.from(str);
  if (chars.length <= maxGraphemes) return str;
  return chars.slice(0, maxGraphemes).join("") + ellipsis;
}
