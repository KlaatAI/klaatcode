# SPEC: compileFilter — Record Filter DSL

This document is the single source of truth for `src/filter.ts`. Every rule
below is normative.

## 1. Signature

```ts
export class FilterSyntaxError extends Error {
  position: number; // 0-based character offset into the source expression
}
export function compileFilter(
  expr: string
): (record: Record<string, unknown>) => boolean;
```

`compileFilter` parses `expr` once. All syntax errors are thrown by
`compileFilter` itself (as `FilterSyntaxError`); the returned predicate NEVER
throws — type mismatches at evaluation time simply yield `false` per the
semantic rules in section 5.

## 2. Grammar (EBNF)

```
expr        = orExpr ;
orExpr      = andExpr , { "or" , andExpr } ;
andExpr     = notExpr , { "and" , notExpr } ;
notExpr     = "not" , notExpr | primary ;
primary     = "(" , expr , ")" | comparison ;
comparison  = fieldPath , ( compOp , literal
                          | "contains" , literal
                          | "in" , "[" , [ literal , { "," , literal } ] , "]" ) ;
compOp      = "=" | "!=" | ">" | ">=" | "<" | "<=" ;
fieldPath   = ident , { "." , ident } ;
literal     = string | number | "true" | "false" | "null" ;
```

Precedence (tightest first): `not`, then `and`, then `or`. `and`/`or` are
left-associative. Parentheses override precedence.

## 3. Tokens

Whitespace (space, tab, CR, LF) separates tokens and is otherwise ignored,
including before and after the expression.

- **ident**: `[A-Za-z_][A-Za-z0-9_]*`. The words `and`, `or`, `not`,
  `contains`, `in`, `true`, `false`, `null` are reserved (case-sensitive,
  lowercase) and may NOT be used as path segments.
- **string**: double-quoted. Exactly two escape sequences exist: `\"`
  (literal double quote) and `\\` (literal backslash). Any other `\x` is a
  syntax error at the offset of the backslash. A string that reaches end of
  input without a closing `"` is *unterminated* (see section 6).
- **number**: `-?[0-9]+(\.[0-9]+)?` — integers and decimals, optionally
  negative. A `-` not immediately followed by a digit is an unexpected
  character. No exponent syntax.
- **symbols**: `=` `!=` `>` `>=` `<` `<=` `(` `)` `[` `]` `,` `.`
  A `!` not immediately followed by `=` is an unexpected character. Any
  character that cannot start a token (e.g. `~`, `@`, `;`) is an unexpected
  character.

There is no `==` token: in `a == 1` the first `=` is the operator and the
second `=` fails literal parsing ("expected literal" at its offset).

## 4. Field path resolution

`a.b.c` walks the record one segment at a time. Start at the record; for each
segment, if the current value is a non-null, non-array object, move to its
property; otherwise the path resolves to `null`. A resulting `undefined`
(missing property) is normalized to `null`. So: missing fields, paths through
non-objects (strings, numbers, arrays, null), and explicit `undefined` all
resolve to `null`.

## 5. Evaluation semantics

Let `v` be the resolved field value and `L` the literal.

**Semantic equality** `eq(v, L)`:
- If `L` is `null`: true iff `v` is `null` (after the normalization above).
- Otherwise: true iff `typeof v === typeof L` and `v === L`.
- There is NO cross-type coercion: `30 = "30"` is false, `true = 1` is false.

**Operators:**

| op | rule |
|----|------|
| `=` | `eq(v, L)` |
| `!=` | `!eq(v, L)` |
| `>` `>=` `<` `<=` | true iff BOTH `v` and `L` are numbers and the JS comparison holds; if either is not a number the result is `false` (never an error) |
| `contains` | true iff BOTH `v` and `L` are strings and `v.includes(L)`; otherwise `false` |
| `in [l1, ...]` | true iff `eq(v, li)` for some element; `in []` is always `false` |

`not` is logical negation; `and`/`or` are logical conjunction/disjunction of
the sub-results (evaluation order/short-circuiting is unobservable and
unspecified).

## 6. Errors

All errors are `FilterSyntaxError` with a `position` property (0-based char
offset into `expr`). Message wording is unspecified; the positions are
normative:

| condition | position |
|-----------|----------|
| unexpected character (unknown operator char like `~`, lone `!`, lone `-`, invalid escape's `\`) | offset of that character |
| unterminated string | offset of the OPENING `"` |
| expected `)` (unbalanced open paren) | offset of the offending token, or `expr.length` at end of input |
| expected `[` after `in` | offset of the offending token, or `expr.length` |
| expected literal / field name / operator | offset of the offending token, or `expr.length` |
| trailing tokens after a complete expression (including a stray `)`) | offset of the first extra token |

## 7. Worked examples

Record: `{ name: "Alice", age: 30, active: true, email: "alice@example.com", address: { city: "Paris" }, score: -2.5, middle: null }`

1. `age > 20` → **true**; `age > 30` → **false**.
2. `name = "Alice"` → **true**; `name = "alice"` → **false** (case matters).
3. `age = "30"` → **false** (number never equals string).
4. `middle = null` → **true**; `nickname = null` → **true** (missing field);
   `name != null` → **true**.
5. `email contains "@example"` → **true**; `age contains "3"` → **false**
   (field is not a string).
6. `name > 5` → **false** (field not a number); `age > "x"` → **false**
   (literal not a number).
7. `address.city = "Paris"` → **true**; `address.city.zip = null` → **true**
   (walking through the string `"Paris"` yields null);
   `address.country = null` → **true**.
8. `age in [10, 30, 50]` → **true**; `name in ["Bob", "Alice"]` → **true**;
   `age in []` → **false**.
9. `age = 30 or age = 99 and name = "Bob"` → **true**: parsed as
   `age = 30 or (age = 99 and name = "Bob")` because `and` binds tighter.
   With parens, `(age = 30 or age = 99) and name = "Bob"` → **false**.
10. `not age = 30 and name = "Bob" or active = true` → **true**: parsed as
    `((not age = 30) and name = "Bob") or active = true`.
11. `score = -2.5` → **true**; `score < 0` → **true**.
12. `quote = "say \"hi\""` matches a record where `quote` is `say "hi"`.

Error examples (source expression → position):

- `name ~ "x"` → unexpected character at **5**.
- `a ! 3` → unexpected character at **2**.
- `name = "abc` → unterminated string at **7**.
- `(a = 1` → expected `)` at **6** (end of input).
- `a = 1 b` → trailing tokens at **6**.
- `a = 1)` → trailing tokens at **5**.
- `price in 5` → expected `[` at **9**.
- `a =` → expected literal at **3**.
