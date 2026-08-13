/**
 * Invoice aggregation.
 *
 * By the time lines reach this module every per-line amount is integer
 * cents (the discount and tax stages own the rounding), so aggregation is
 * pure integer addition. `assertish` rounding here only guards against
 * float noise leaking in from upstream — it must never change a value that
 * honors the conventions.
 */

import { roundHalfUp } from "../money/round";
import type { TaxedLine } from "../tax/calculator";

export interface InvoiceTotals {
  /** Sum of per-line discounted nets. */
  subtotalCents: number;
  /** Sum of per-line tax amounts. */
  taxCents: number;
  /** subtotalCents + taxCents. Always equals the sum of line totals. */
  totalCents: number;
}

/** Aggregate taxed lines into invoice totals. */
export function computeTotals(lines: TaxedLine[]): InvoiceTotals {
  let subtotal = 0;
  let tax = 0;
  for (const line of lines) {
    subtotal += line.discounted.netCents;
    tax += line.taxCents;
  }
  // Guard against float artifacts from upstream stages; on convention-
  // honoring input these are identity operations on integers.
  const subtotalCents = roundHalfUp(subtotal);
  const taxCents = roundHalfUp(tax);
  return {
    subtotalCents,
    taxCents,
    totalCents: subtotalCents + taxCents,
  };
}

/** Sum of per-line totals — must always equal InvoiceTotals.totalCents. */
export function sumLineTotals(lines: TaxedLine[]): number {
  return roundHalfUp(lines.reduce((s, l) => s + l.lineTotalCents, 0));
}
