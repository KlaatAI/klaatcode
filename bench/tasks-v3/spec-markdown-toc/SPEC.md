# SPEC: generateToc — Markdown Table of Contents Generator

This document is the single source of truth for `generateToc` in `src/toc.ts`.
Every behavior below is normative. Where this spec differs from CommonMark or
GitHub's real renderer, THIS SPEC WINS.

## 1. Signature

```ts
export interface TocOptions {
  minDepth?: number; // default 1
  maxDepth?: number; // default 6
}
export function generateToc(markdown: string, options?: TocOptions): string;
```

`generateToc` returns a markdown bullet list of links to the headings of the
input document, or the empty string `""` if no headings are included.

## 2. Option validation

Before any parsing, validate the resolved options (after applying defaults):

- `minDepth` and `maxDepth` MUST both be integers (`Number.isInteger`).
- `minDepth >= 1`, `maxDepth <= 6`, and `minDepth <= maxDepth`.

If any check fails, throw a `RangeError`. (Message text is unspecified; the
error type is normative.)

## 3. Line model

Split the input into lines on `\r?\n` (both LF and CRLF are line breaks).
Process lines top to bottom, tracking fenced-code-block state (section 4)
first, then heading recognition (section 5) for lines not inside a fence.

## 4. Fenced code blocks

Headings inside fenced code blocks are NOT headings.

**Opening a fence.** When not already inside a fence: strip ALL leading spaces
and tabs from the line (any amount of indentation is allowed for fences). If
the remainder begins with a run of 3 or more backticks (`` ` ``) or 3 or more
tildes (`~`), the line opens a fence. The fence character is the character
used (backtick or tilde). Anything after the run is the *info string* (e.g.
```` ```js ````) and is ignored.

**Closing a fence.** While inside a fence, a line closes it if, after
stripping leading and trailing spaces/tabs, the line consists of 3 or more of
the SAME fence character that opened the fence, and nothing else. Lines of the
other fence character, or fence-char runs followed by other text, do NOT
close it. The closing line itself is consumed (it is neither a heading nor a
new fence opener).

**Unclosed fence.** If a fence is never closed, it runs to end of input: every
remaining line is inside the fence.

Lines inside a fence are ignored entirely (they cannot be headings and cannot
open nested fences).

## 5. Heading recognition (ATX only)

Only ATX headings are recognized. Setext headings (a text line underlined
with `===` or `---`) are IGNORED — both lines are treated as ordinary text.

A line (not inside a fence) is a heading iff it matches all of:

1. Zero to three leading SPACE characters (tabs do not count as heading
   indentation; a line indented with a tab is not a heading). Four or more
   leading spaces: not a heading.
2. Then a run of 1–6 `#` characters. The run length is the heading *depth*.
   A run of 7 or more `#` is not a heading.
3. Then at least one space or tab, then the *raw text*. A `#` run followed
   directly by non-whitespace (e.g. `#NoSpace`) is not a heading. A `#` run
   followed by end-of-line (e.g. a line containing only `##`) is an empty
   heading and is IGNORED.

**Raw text cleanup**, in order:

1. Trim leading and trailing spaces/tabs.
2. If the result consists only of `#` characters and spaces/tabs (e.g. the
   line was `## ###`), the heading is empty: IGNORE the line.
3. Otherwise, if the text ends with a run of `#` characters immediately
   preceded by a space or tab, remove that run and the whitespace before it
   (ATX closing sequence: `## Title ##` → `Title`). A trailing `#` NOT
   preceded by whitespace is kept (`# C#` → `C#`).
4. Trim again. If empty, ignore the line.

The surviving text is the heading's *source text*.

## 6. Display text (inline formatting)

The *display text* (used verbatim inside the link brackets) is derived from
the source text by applying these replacements in exactly this order:

1. **Links and images.** Every occurrence of `[text](url)` is replaced by
   `text`. An immediately preceding `!` (image syntax `![alt](url)`) is
   removed as well. `text` is the characters between `[` and the first
   following `]`; `url` is the characters between `(` and the first following
   `)`. Nested brackets need not be supported.
2. **Inline code.** Every backtick character `` ` `` is removed.
3. **Bold.** Every `**` sequence is removed, then every `__` sequence is
   removed (non-overlapping, scanning left to right).
4. **Italic.** Every remaining `*` character is removed.
5. Single `_` characters are PRESERVED (identifiers like `snake_case` keep
   their underscores).

## 7. Slugs (GitHub-style, ASCII rules)

The *base slug* of a heading is derived from its display text:

1. Lowercase the display text (`toLowerCase`).
2. Remove every character that is NOT one of: `a`–`z`, `0`–`9`, space (` `),
   hyphen (`-`), underscore (`_`). (Everything else — punctuation, unicode —
   is deleted.)
3. Replace EACH space with a hyphen. Spaces are not collapsed first: two
   consecutive spaces produce two consecutive hyphens (`a  b` → `a--b`).

The base slug may be empty (e.g. display text `!!!` → base slug ``).

### 7.1 Duplicate suffixes

Slugs are de-duplicated across ALL recognized headings of the document in
document order — including headings that the depth filter (section 8) will
later exclude from the output. For each heading, let `n` be the number of
earlier headings with the same base slug:

- `n = 0`: final slug = base slug.
- `n >= 1`: final slug = base slug + `-` + `n` (i.e. `-1`, `-2`, …).

An empty base slug participates normally: the second heading whose base slug
is empty gets final slug `-1`.

## 8. Depth filter and output

A heading is *included* in the output iff `minDepth <= depth <= maxDepth`.
(Excluded headings still consumed slug numbers per 7.1.)

For each included heading, in document order, emit one line:

```
"  ".repeat(depth - minDepth) + "- [" + displayText + "](#" + slug + ")"
```

i.e. 2 spaces of indentation per level relative to `minDepth`. Indentation
depends only on the heading's own depth, not on what headings precede it.

Join the lines with `"\n"`. No trailing newline. If no headings are included,
return `""`.

## 9. Worked examples

Input (default options):

```
# Alpha
## Beta
### Gamma
## Delta
```

Output:

```
- [Alpha](#alpha)
  - [Beta](#beta)
    - [Gamma](#gamma)
  - [Delta](#delta)
```

With `{ minDepth: 2 }` the same input yields:

```
- [Beta](#beta)
  - [Gamma](#gamma)
- [Delta](#delta)
```

Formatting: `# See [the docs](https://x.dev)` →
`- [See the docs](#see-the-docs)`.

Duplicates: three `# Setup` headings → `#setup`, `#setup-1`, `#setup-2`.

Filter/dedupe interaction: document `## Install` then `# Install`, with
`{ maxDepth: 1 }` → the only output line is `- [Install](#install-1)`
(the depth-2 heading claimed the bare `install` slug first).

Punctuation: `# Hello, World!` → `- [Hello, World!](#hello-world)`.

Empty slug: `# !!!` then another `# !!!` → `- [!!!](#)` and `- [!!!](#-1)`.
