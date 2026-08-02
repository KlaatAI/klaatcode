/**
 * Rounding conventions for the billing pipeline.
 *
 * THE ONE RULE: monetary amounts are integer cents everywhere. Fractional
 * values may only exist *inside* a single computation step, and every such
 * step must round half-up back to integer cents before handing its result to
 * the next stage. Concretely:
 *
 *   - discount application rounds the discounted net per line
 *     (see src/discounts/), and
 *   - tax calculation rounds the per-line tax amount (see src/tax/).
 *
 * Aggregation (src/billing/totals.ts) therefore only ever adds integers.
 */

/**
 * Round half-up to the nearest integer. 0.5 rounds away from zero for the
 * non-negative amounts this pipeline deals in: 74.5 -> 75, 74.4999 -> 74.
 */
export function roundHalfUp(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error(`Cannot round non-finite value: ${value}`);
  }
  if (value < 0) {
    // Negative amounts never occur in practice (discounts clamp at zero),
    // but keep the behavior symmetric rather than silently biased.
    return -Math.round(-value);
  }
  return Math.round(value);
}

/**
 * Banker's rounding (half to even). Not used by the billing conventions —
 * kept for the FX preview endpoints which follow ISO recommendations.
 */
export function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * Guard used at aggregation boundaries: asserts the amount is an integer
 * number of cents (within float noise) and returns it normalized.
 */
export function assertIntegerCents(value: number, label: string): number {
  const rounded = Math.round(value);
  if (Math.abs(value - rounded) > 1e-6) {
    throw new Error(
      `${label} expected integer cents, got ${value} (off by ${value - rounded})`,
    );
  }
  return rounded;
}
