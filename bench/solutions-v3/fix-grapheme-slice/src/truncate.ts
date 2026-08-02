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
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function truncateDisplay(
  str: string,
  maxGraphemes: number,
  ellipsis = "…",
): string {
  const graphemes = Array.from(segmenter.segment(str), (s) => s.segment);
  if (graphemes.length <= maxGraphemes) return str;
  return graphemes.slice(0, maxGraphemes).join("") + ellipsis;
}
