/**
 * Invoice assembly — the public entry point of the billing pipeline.
 *
 * Pipeline: cart -> gross lines -> discounted lines -> taxed lines -> totals.
 * Every stage hands the next stage integer cents; see src/money/round.ts for
 * the rounding conventions and which stage owns which rounding point.
 */

import { assertValidCart } from "../cart/validate";
import { buildGrossLines, type Cart } from "../cart/cart";
import { applyDiscounts } from "../discounts/apply";
import { taxLines } from "../tax/calculator";
import { computeTotals } from "./totals";
import type { CurrencyCode } from "../money/currency";

export interface InvoiceLine {
  productId: string;
  productName: string;
  quantity: number;
  unitPriceCents: number;
  /** quantity * unitPriceCents, exact. */
  grossCents: number;
  /** Net after discounts — integer cents per the discount-stage contract. */
  netCents: number;
  /** Discount codes that touched this line, in application order. */
  discountCodes: string[];
  /** Decimal tax rate applied to this line. */
  taxRate: number;
  /** Per-line tax, integer cents. */
  taxCents: number;
  /** netCents + taxCents. */
  totalCents: number;
}

export interface Invoice {
  cartId: string;
  currency: CurrencyCode;
  jurisdiction: string;
  lines: InvoiceLine[];
  /** Sum of line nets. */
  subtotalCents: number;
  /** Sum of line taxes. */
  taxCents: number;
  /** Grand total. Invariant: equals the sum of line totalCents. */
  totalCents: number;
}

export interface BuildInvoiceOptions {
  /** Tax jurisdiction code, e.g. "CA" — see src/tax/rates.ts. */
  jurisdiction: string;
}

/**
 * Build an invoice for a cart. Throws when the cart fails validation.
 * This is the only supported way to price a cart; callers must not
 * re-derive totals from the pieces themselves.
 */
export function buildInvoice(cart: Cart, options: BuildInvoiceOptions): Invoice {
  assertValidCart(cart);

  const gross = buildGrossLines(cart);
  const discounted = applyDiscounts(gross, cart.discounts);
  const taxed = taxLines(discounted, options.jurisdiction);
  const totals = computeTotals(taxed);

  const lines: InvoiceLine[] = taxed.map((line) => ({
    productId: line.discounted.gross.product.id,
    productName: line.discounted.gross.product.name,
    quantity: line.discounted.gross.quantity,
    unitPriceCents: line.discounted.gross.unitPriceCents,
    grossCents: line.discounted.gross.grossCents,
    netCents: line.discounted.netCents,
    discountCodes: [...line.discounted.appliedCodes],
    taxRate: line.taxRate,
    taxCents: line.taxCents,
    totalCents: line.lineTotalCents,
  }));

  return {
    cartId: cart.id,
    currency: cart.currency,
    jurisdiction: options.jurisdiction,
    lines,
    subtotalCents: totals.subtotalCents,
    taxCents: totals.taxCents,
    totalCents: totals.totalCents,
  };
}
