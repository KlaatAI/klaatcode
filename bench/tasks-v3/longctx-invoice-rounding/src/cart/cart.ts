/**
 * Cart model and gross-line construction.
 *
 * A cart is a plain data object supplied by the storefront. The billing
 * pipeline turns it into gross lines (integer cents), applies discounts and
 * tax, and assembles an invoice. Gross amounts are always exact integers:
 * unitPriceCents * quantity involves no rounding.
 */

import { getProduct, type Product } from "../catalog/products";
import { resolveUnitPrice } from "../catalog/pricing";
import type { CurrencyCode } from "../money/currency";
import type { Discount } from "../discounts/types";

export interface CartItem {
  productId: string;
  quantity: number;
}

export interface Cart {
  id: string;
  currency: CurrencyCode;
  items: CartItem[];
  /** Discounts apply in the order listed; see src/discounts/apply.ts. */
  discounts: Discount[];
}

/** A cart line with its resolved product and exact gross amount. */
export interface GrossLine {
  product: Product;
  quantity: number;
  /** Effective unit price after volume-tier resolution (integer cents). */
  unitPriceCents: number;
  /** unitPriceCents * quantity — exact, no rounding involved. */
  grossCents: number;
}

/**
 * Resolve every cart item to a gross line. Items for the same product are
 * kept as separate lines (the storefront already merges duplicates when it
 * wants merged behavior).
 */
export function buildGrossLines(cart: Cart): GrossLine[] {
  return cart.items.map((item) => {
    const product = getProduct(item.productId);
    const unitPriceCents = resolveUnitPrice(product, item.quantity);
    return {
      product,
      quantity: item.quantity,
      unitPriceCents,
      grossCents: unitPriceCents * item.quantity,
    };
  });
}

/** Sum of gross amounts before any discounts or tax (integer cents). */
export function cartGrossTotal(cart: Cart): number {
  return buildGrossLines(cart).reduce((sum, line) => sum + line.grossCents, 0);
}

/** Convenience constructor used by tests and internal tooling. */
export function makeCart(
  id: string,
  currency: CurrencyCode,
  items: CartItem[],
  discounts: Discount[] = [],
): Cart {
  return { id, currency, items, discounts };
}
