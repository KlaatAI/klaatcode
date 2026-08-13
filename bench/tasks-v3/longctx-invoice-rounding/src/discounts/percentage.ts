/**
 * Percentage discount application.
 *
 * Per the billing rounding conventions (src/money/round.ts), the discounted
 * net is rounded half-up to integer cents here, at the line level — this is
 * the designated rounding point for the discount stage. Downstream stages
 * (tax, totals) assume the value they receive is already integral.
 */

import { roundHalfUp } from "../money/round";

/**
 * Apply a percentage discount to a line amount.
 *
 * @param amountCents current line net in integer cents
 * @param percent     percent off, e.g. 10 for 10% off
 * @returns discounted net in integer cents (rounded half-up)
 */
export function applyPercentage(amountCents: number, percent: number): number {
  if (percent < 0 || percent > 100) {
    throw new Error(`Percentage out of range: ${percent}`);
  }
  const discounted = amountCents - (amountCents * percent) / 100;
  return roundHalfUp(discounted);
}

/**
 * The cent amount a percentage discount removes from a line. Derived from
 * applyPercentage so the two can never disagree.
 */
export function percentageOffAmount(amountCents: number, percent: number): number {
  return amountCents - applyPercentage(amountCents, percent);
}
