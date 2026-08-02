/**
 * Interval set operations over closed-open numeric intervals [start, end).
 * All functions accept arbitrary input, return normalized fresh arrays, and
 * never mutate their arguments.
 */
export type Iv = [number, number];

export function normalize(ivs: Iv[]): Iv[] {
  const xs: Iv[] = ivs.filter(([s, e]) => s < e).map(([s, e]) => [s, e] as Iv);
  xs.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const out: Iv[] = [];
  for (const [s, e] of xs) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) {
      if (e > last[1]) last[1] = e;
    } else {
      out.push([s, e]);
    }
  }
  return out;
}

export function union(a: Iv[], b: Iv[]): Iv[] {
  return normalize([...a, ...b]);
}

export function intersect(a: Iv[], b: Iv[]): Iv[] {
  const A = normalize(a);
  const B = normalize(b);
  const out: Iv[] = [];
  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    const s = Math.max(A[i][0], B[j][0]);
    const e = Math.min(A[i][1], B[j][1]);
    if (s < e) out.push([s, e]);
    if (A[i][1] <= B[j][1]) i++;
    else j++;
  }
  return out;
}

export function subtract(a: Iv[], b: Iv[]): Iv[] {
  const A = normalize(a);
  const B = normalize(b);
  const out: Iv[] = [];
  for (const [s0, e] of A) {
    let s = s0;
    for (const [bs, be] of B) {
      if (be <= s || bs >= e) continue;
      if (bs > s) out.push([s, bs]);
      s = Math.max(s, be);
      if (s >= e) break;
    }
    if (s < e) out.push([s, e]);
  }
  return out;
}

export function freeSlots(busy: Iv[], bounds: Iv): Iv[] {
  return subtract([bounds], busy);
}
