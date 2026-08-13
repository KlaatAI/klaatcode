/**
 * globMatch(pattern, path) — glob matching with `*`, `?`, `**` (whole-segment,
 * zero or more segments), `{a,b}` alternation (non-nested, alternatives may
 * contain slashes) and `[abc]` / `[a-z]` / `[!...]` character classes.
 * Whole-path, case-sensitive matching; "/" is the only separator.
 */
export function globMatch(pattern: string, path: string): boolean {
  for (const p of expandBraces(pattern)) {
    if (matchOne(p, path)) return true;
  }
  return false;
}

/** Expand non-nested {a,b,...} alternations into the cartesian set of plain patterns. */
function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf("{");
  if (open === -1) return [pattern];
  const close = pattern.indexOf("}", open);
  if (close === -1) return [pattern]; // unmatched "{" is literal
  const prefix = pattern.slice(0, open);
  const alts = pattern.slice(open + 1, close).split(",");
  const rests = expandBraces(pattern.slice(close + 1));
  const out: string[] = [];
  for (const alt of alts) {
    for (const rest of rests) out.push(prefix + alt + rest);
  }
  return out;
}

function matchOne(pattern: string, path: string): boolean {
  const pSegs = pattern.split("/");
  const tSegs = path.split("/");
  return matchSegs(pSegs, tSegs, 0, 0);
}

function matchSegs(pSegs: string[], tSegs: string[], pi: number, ti: number): boolean {
  if (pi === pSegs.length) return ti === tSegs.length;
  if (pSegs[pi] === "**") {
    // match zero segments...
    if (matchSegs(pSegs, tSegs, pi + 1, ti)) return true;
    // ...or consume one segment and stay on "**"
    return ti < tSegs.length && matchSegs(pSegs, tSegs, pi, ti + 1);
  }
  return (
    ti < tSegs.length &&
    segToRegex(pSegs[pi]).test(tSegs[ti]) &&
    matchSegs(pSegs, tSegs, pi + 1, ti + 1)
  );
}

const segCache = new Map<string, RegExp>();

function segToRegex(seg: string): RegExp {
  const cached = segCache.get(seg);
  if (cached) return cached;
  let re = "^";
  let i = 0;
  while (i < seg.length) {
    const c = seg[i];
    if (c === "*") {
      re += "[^/]*";
      i++;
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else if (c === "[") {
      const j = seg.indexOf("]", i + 1);
      if (j === -1) {
        re += "\\["; // unmatched "[" is literal
        i++;
        continue;
      }
      let body = seg.slice(i + 1, j);
      let neg = false;
      if (body.startsWith("!")) {
        neg = true;
        body = body.slice(1);
      }
      const escaped = body.replace(/[\\\]^]/g, (m) => "\\" + m);
      re += (neg ? "[^/" : "[") + escaped + "]";
      i = j + 1;
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i++;
    }
  }
  const rx = new RegExp(re + "$");
  segCache.set(seg, rx);
  return rx;
}
