/**
 * Cart validation. Runs before any pricing math so that downstream stages
 * can assume well-formed input (positive integer quantities, known products,
 * supported currency, sane discount definitions).
 */

import { hasProduct } from "../catalog/products";
import { isSupportedCurrency } from "../money/currency";
import type { Cart } from "./cart";
import type { Discount } from "../discounts/types";

export interface ValidationIssue {
  field: string;
  message: string;
}

/** Collect all validation problems for a cart (empty array = valid). */
export function validateCart(cart: Cart): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!cart.id || cart.id.trim() === "") {
    issues.push({ field: "id", message: "Cart id is required" });
  }
  if (!isSupportedCurrency(cart.currency)) {
    issues.push({ field: "currency", message: `Unsupported currency: ${cart.currency}` });
  }
  if (cart.items.length === 0) {
    issues.push({ field: "items", message: "Cart must contain at least one item" });
  }

  cart.items.forEach((item, i) => {
    if (!hasProduct(item.productId)) {
      issues.push({ field: `items[${i}].productId`, message: `Unknown product: ${item.productId}` });
    }
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      issues.push({ field: `items[${i}].quantity`, message: `Quantity must be a positive integer, got ${item.quantity}` });
    }
    if (item.quantity > 999) {
      issues.push({ field: `items[${i}].quantity`, message: "Quantities above 999 require a purchase order" });
    }
  });

  cart.discounts.forEach((d, i) => {
    issues.push(...validateDiscount(d, i));
  });

  return issues;
}

function validateDiscount(discount: Discount, index: number): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const field = `discounts[${index}]`;
  if (!discount.code || discount.code.trim() === "") {
    issues.push({ field, message: "Discount code is required" });
  }
  if (discount.kind === "percentage") {
    if (discount.percent <= 0 || discount.percent > 100) {
      issues.push({ field, message: `Percentage must be in (0, 100], got ${discount.percent}` });
    }
  } else if (discount.kind === "fixed") {
    if (!Number.isInteger(discount.amountCents) || discount.amountCents <= 0) {
      issues.push({ field, message: `Fixed discount must be a positive integer cent amount, got ${discount.amountCents}` });
    }
  }
  return issues;
}

/** Throw a descriptive error when the cart is invalid. */
export function assertValidCart(cart: Cart): void {
  const issues = validateCart(cart);
  if (issues.length > 0) {
    const summary = issues.map((i) => `${i.field}: ${i.message}`).join("; ");
    throw new Error(`Invalid cart ${cart.id}: ${summary}`);
  }
}
