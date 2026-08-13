/**
 * Unit-price resolution, including volume tiers.
 *
 * Tier prices are configured as explicit integer cents (never derived by
 * percentage at runtime) so that price resolution introduces no rounding of
 * its own — rounding is owned by the discount and tax stages.
 */

import type { Product } from "./products";

export interface VolumeTier {
  /** Minimum quantity (inclusive) at which this tier price applies. */
  minQty: number;
  /** Unit price in integer cents at this tier. */
  unitPriceCents: number;
}

/**
 * Volume pricing per product id. Tiers must be sorted by ascending minQty;
 * the highest tier whose minQty is satisfied wins.
 */
const VOLUME_TIERS: Record<string, VolumeTier[]> = {
  "cable-usbc": [
    { minQty: 10, unitPriceCents: 903 },
    { minQty: 50, unitPriceCents: 850 },
  ],
  "mug-ceramic": [{ minQty: 12, unitPriceCents: 900 }],
  "snack-bar": [{ minQty: 6, unitPriceCents: 1399 }],
};

/**
 * Resolve the effective unit price for a product at a given quantity.
 * Falls back to the catalog list price when no tier applies.
 */
export function resolveUnitPrice(product: Product, quantity: number): number {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error(`Quantity must be a positive integer, got ${quantity}`);
  }
  const tiers = VOLUME_TIERS[product.id];
  if (!tiers || tiers.length === 0) {
    return product.unitPriceCents;
  }
  let price = product.unitPriceCents;
  for (const tier of tiers) {
    if (quantity >= tier.minQty) {
      price = tier.unitPriceCents;
    }
  }
  return price;
}

/** True when the product has any volume tier configured. */
export function hasVolumePricing(productId: string): boolean {
  return Boolean(VOLUME_TIERS[productId]?.length);
}

/**
 * The quantity at which the next cheaper tier kicks in, or undefined when
 * the customer is already at the best price. Used by cart upsell hints.
 */
export function nextTierAt(productId: string, quantity: number): number | undefined {
  const tiers = VOLUME_TIERS[productId];
  if (!tiers) return undefined;
  for (const tier of tiers) {
    if (quantity < tier.minQty) {
      return tier.minQty;
    }
  }
  return undefined;
}
