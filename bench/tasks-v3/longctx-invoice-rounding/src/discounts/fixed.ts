/**
 * Fixed-amount discount application.
 *
 * Fixed discounts are defined in integer cents, so applying one involves no
 * rounding at all — the only rule is clamping: a line's net can never go
 * below zero, and the clamped remainder is *not* carried to other lines.
 */

/**
 * Apply a fixed cent discount to a line amount.
 *
 * @param amountCents current line net in integer cents
 * @param offCents    discount amount in integer cents
 * @returns discounted net in integer cents, clamped at zero
 */
export function applyFixed(amountCents: number, offCents: number): number {
  if (!Number.isInteger(offCents) || offCents < 0) {
    throw new Error(`Fixed discount must be a non-negative integer, got ${offCents}`);
  }
  const discounted = amountCents - offCents;
  return discounted < 0 ? 0 : discounted;
}

/**
 * The cent amount actually removed (accounts for clamping — a 500c discount
 * on a 300c line only removes 300c).
 */
export function fixedOffAmount(amountCents: number, offCents: number): number {
  return amountCents - applyFixed(amountCents, offCents);
}
