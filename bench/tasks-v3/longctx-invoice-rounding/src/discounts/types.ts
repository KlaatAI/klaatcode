/**
 * Discount definitions.
 *
 * Discounts are applied per line, in the order they appear on the cart.
 * A discount with a `productId` filter only touches matching lines; without
 * a filter it applies to every line.
 *
 * Rounding contract (see src/money/round.ts): every discount application
 * returns integer cents. Percentage discounts round half-up at the line
 * level; fixed discounts are integral by construction.
 */

export interface PercentageDiscount {
  kind: "percentage";
  /** Promo code, e.g. "SAVE10". */
  code: string;
  /** Percent off in [0, 100], e.g. 10 for 10% off. */
  percent: number;
  /** When set, only lines for this product are discounted. */
  productId?: string;
}

export interface FixedDiscount {
  kind: "fixed";
  code: string;
  /** Amount off per line in integer cents. Clamped so nets never go negative. */
  amountCents: number;
  productId?: string;
}

export type Discount = PercentageDiscount | FixedDiscount;

/** Whether a discount targets the given product line. */
export function discountApplies(discount: Discount, productId: string): boolean {
  return discount.productId === undefined || discount.productId === productId;
}

/** Human-readable label for receipts, e.g. "SAVE10 (10% off)". */
export function describeDiscount(discount: Discount): string {
  if (discount.kind === "percentage") {
    return `${discount.code} (${discount.percent}% off)`;
  }
  return `${discount.code} (fixed)`;
}
