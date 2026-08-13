/**
 * Proportional allocation of an integer cent amount across weights, with
 * largest-remainder distribution so the parts always sum to the whole.
 *
 * Used by the refunds service to split an order-level refund across lines;
 * the forward pricing path in src/billing/ never allocates.
 */

/**
 * Split `totalCents` across `weights` proportionally. The results are
 * integers that sum exactly to totalCents; remainders go to the largest
 * fractional parts first (ties broken by lowest index for determinism).
 */
export function allocateProportional(totalCents: number, weights: number[]): number[] {
  if (!Number.isInteger(totalCents)) {
    throw new Error(`allocateProportional requires integer cents, got ${totalCents}`);
  }
  if (weights.length === 0) {
    return [];
  }
  const weightSum = weights.reduce((s, w) => s + w, 0);
  if (weightSum <= 0) {
    throw new Error("Weights must sum to a positive value");
  }

  const raw = weights.map((w) => (totalCents * w) / weightSum);
  const floors = raw.map((r) => Math.floor(r));
  let remainder = totalCents - floors.reduce((s, f) => s + f, 0);

  const order = raw
    .map((r, i) => ({ frac: r - Math.floor(r), i }))
    .sort((a, b) => (b.frac !== a.frac ? b.frac - a.frac : a.i - b.i));

  const result = [...floors];
  for (const { i } of order) {
    if (remainder <= 0) break;
    result[i] += 1;
    remainder -= 1;
  }
  return result;
}

/** Split evenly across n parts (first parts absorb the remainder). */
export function allocateEven(totalCents: number, parts: number): number[] {
  if (parts <= 0 || !Number.isInteger(parts)) {
    throw new Error(`Parts must be a positive integer, got ${parts}`);
  }
  return allocateProportional(totalCents, new Array(parts).fill(1));
}
