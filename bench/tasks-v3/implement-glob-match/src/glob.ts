/**
 * globMatch(pattern, path) — test whether a slash-separated path matches a
 * glob pattern. The whole path must match (no substring matching). Matching is
 * case-sensitive and there is no special treatment of dotfiles.
 *
 * Paths use "/" as the only separator. Patterns support:
 *
 *   `*`   — matches any sequence of characters EXCEPT "/", including the empty
 *           sequence. E.g. "*.ts" matches "a.ts" and ".ts" but never "a/b.ts".
 *
 *   `?`   — matches exactly one character that is not "/".
 *           E.g. "a?c" matches "abc" but not "ac" and not "a/c".
 *
 *   `**`  — only special when it forms a COMPLETE path segment (i.e. "**",
 *           "**/x", "x/**", "x/**/y"). It matches zero or more whole segments:
 *             - "a/**/b" matches "a/b" (zero segments), "a/x/b", "a/x/y/b"
 *             - "**/f.ts" matches "f.ts" and "d/e/f.ts"
 *             - "a/**" matches "a" itself and anything under it ("a/b/c")
 *             - "**" alone matches every path
 *           When "**" appears inside a segment (e.g. "a**b") it is NOT
 *           special and behaves exactly like a single "*".
 *
 *   `{a,b,...}` — alternation: matches if any comma-separated alternative
 *           matches in its place. Alternatives may themselves contain "/",
 *           "*", "?", "**" and character classes. Nesting of braces inside
 *           braces is NOT required and will not appear in tests. A "{" without
 *           a matching "}" is treated as a literal character. An alternation
 *           may appear anywhere in the pattern, and a pattern may contain
 *           several (non-nested) alternations.
 *
 *   `[...]` — character class matching exactly one character (never "/"):
 *             - "[abc]" matches "a", "b" or "c"
 *             - "[a-z]" matches ranges (multiple ranges/chars may be mixed)
 *             - "[!abc]" / "[!0-9]" — leading "!" negates the class (matches
 *               any single non-"/" character NOT listed)
 *           Class bodies are non-empty and never contain "]", "/" or nested
 *           brackets. A "[" without a matching "]" is a literal "[".
 *
 * Every other character matches itself literally — in particular "." has no
 * special meaning ("*.ts" must NOT match "ats").
 *
 * @param pattern glob pattern as described above
 * @param path    slash-separated path to test
 * @returns       true iff the entire path matches the entire pattern
 */
export function globMatch(pattern: string, path: string): boolean {
  throw new Error("not implemented");
}
