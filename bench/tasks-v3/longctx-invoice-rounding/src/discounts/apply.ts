/**
 * Discount orchestration: turns gross lines into discounted (net) lines.
 *
 * Rules:
 *  - Discounts apply per line, in the order they appear on the cart.
 *  - A discount with a productId filter only touches matching lines.
 *  - Each application returns integer cents (see the stage modules), so a
 *    discounted line is always integral no matter how many discounts stack.
 */

import type { GrossLine } from "../cart/cart";
import { applyPercentage } from "./percentage";
import { applyFixed } from "./fixed";
import { discountApplies, type Discount } from "./types";

/** A line after the discount stage. */
export interface DiscountedLine {
  /** The gross line this was derived from. */
  gross: GrossLine;
  /**
   * Net amount after all applicable discounts, in integer cents.
   * This is the base the tax stage computes from.
   */
  netCents: number;
  /** Codes of the discounts that actually touched this line, in order. */
  appliedCodes: string[];
}

/**
 * Apply the cart's discounts to every gross line.
 * Lines no discount matches pass through with netCents === grossCents.
 */
export function applyDiscounts(
  lines: GrossLine[],
  discounts: Discount[],
): DiscountedLine[] {
  return lines.map((line) => discountLine(line, discounts));
}

/** Apply all matching discounts to a single line, in cart order. */
export function discountLine(
  line: GrossLine,
  discounts: Discount[],
): DiscountedLine {
  let net = line.grossCents;
  const appliedCodes: string[] = [];

  for (const discount of discounts) {
    if (!discountApplies(discount, line.product.id)) {
      continue;
    }
    if (discount.kind === "percentage") {
      net = applyPercentage(net, discount.percent);
    } else {
      net = applyFixed(net, discount.amountCents);
    }
    appliedCodes.push(discount.code);
  }

  return { gross: line, netCents: net, appliedCodes };
}

/** Total cents removed by discounts across all lines (for receipt display). */
export function totalDiscountCents(lines: DiscountedLine[]): number {
  return lines.reduce(
    (sum, line) => sum + (line.gross.grossCents - line.netCents),
    0,
  );
}
