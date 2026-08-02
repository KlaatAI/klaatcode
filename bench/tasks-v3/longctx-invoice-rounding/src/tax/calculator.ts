/**
 * Tax calculation.
 *
 * Tax is computed per line, on the discounted net, and rounded half-up to
 * integer cents — this is the tax stage's designated rounding point (see
 * src/money/round.ts). The input net must already be integer cents; the
 * discount stage guarantees that.
 */

import { roundHalfUp } from "../money/round";
import { rateFor } from "./rates";
import type { DiscountedLine } from "../discounts/apply";

/** A line after the tax stage. */
export interface TaxedLine {
  discounted: DiscountedLine;
  /** The decimal rate that was applied, for receipt display. */
  taxRate: number;
  /** Tax amount in integer cents (rounded half-up per line). */
  taxCents: number;
  /** netCents + taxCents. */
  lineTotalCents: number;
}

/** Compute tax for a single discounted line. */
export function taxLine(line: DiscountedLine, jurisdictionCode: string): TaxedLine {
  const taxRate = rateFor(jurisdictionCode, line.gross.product.taxCategory);
  const taxCents = roundHalfUp(line.netCents * taxRate);
  return {
    discounted: line,
    taxRate,
    taxCents,
    lineTotalCents: line.netCents + taxCents,
  };
}

/** Compute tax for every line in a cart. */
export function taxLines(
  lines: DiscountedLine[],
  jurisdictionCode: string,
): TaxedLine[] {
  return lines.map((line) => taxLine(line, jurisdictionCode));
}

/**
 * Effective blended tax rate across an invoice (tax / net), for analytics
 * dashboards. Returns 0 for zero-net invoices.
 */
export function effectiveRate(lines: TaxedLine[]): number {
  const net = lines.reduce((s, l) => s + l.discounted.netCents, 0);
  const tax = lines.reduce((s, l) => s + l.taxCents, 0);
  return net === 0 ? 0 : tax / net;
}
