/**
 * Product catalog. In production this is backed by the merchandising
 * service; for the billing pipeline it is a read-only lookup table.
 */

export type TaxCategory = "standard" | "reduced" | "exempt";

export interface Product {
  id: string;
  name: string;
  /** List price in integer minor units (cents). */
  unitPriceCents: number;
  taxCategory: TaxCategory;
  /** Optional merchandising metadata, unused by billing math. */
  sku?: string;
  weightGrams?: number;
}

const PRODUCTS: readonly Product[] = [
  { id: "kbd-tkl", name: "Tenkeyless Keyboard", unitPriceCents: 8999, taxCategory: "standard", sku: "KB-100", weightGrams: 820 },
  { id: "mouse-pro", name: "Pro Wireless Mouse", unitPriceCents: 6499, taxCategory: "standard", sku: "MS-210", weightGrams: 110 },
  { id: "cable-usbc", name: "USB-C Cable 2m", unitPriceCents: 1003, taxCategory: "standard", sku: "CB-002", weightGrams: 65 },
  { id: "hub-7port", name: "7-Port USB Hub", unitPriceCents: 2004, taxCategory: "standard", sku: "HB-007", weightGrams: 240 },
  { id: "stand-alu", name: "Aluminum Laptop Stand", unitPriceCents: 3002, taxCategory: "standard", sku: "ST-014", weightGrams: 1300 },
  { id: "mat-desk", name: "Desk Mat XL", unitPriceCents: 2400, taxCategory: "standard", sku: "DM-090", weightGrams: 540 },
  { id: "mug-ceramic", name: "Ceramic Mug", unitPriceCents: 1002, taxCategory: "standard", sku: "MG-001", weightGrams: 390 },
  { id: "book-ts", name: "TypeScript Field Guide", unitPriceCents: 1000, taxCategory: "exempt", sku: "BK-201", weightGrams: 610 },
  { id: "snack-bar", name: "Granola Bar 12-pack", unitPriceCents: 1499, taxCategory: "reduced", sku: "GR-012", weightGrams: 480 },
  { id: "filter-water", name: "Water Filter Cartridge", unitPriceCents: 2002, taxCategory: "reduced", sku: "WF-033", weightGrams: 320 },
] as const;

/** Look up a product by id. Throws for unknown ids — callers validate first. */
export function getProduct(id: string): Product {
  const product = PRODUCTS.find((p) => p.id === id);
  if (!product) {
    throw new Error(`Unknown product: ${id}`);
  }
  return product;
}

/** True when the catalog contains the given product id. */
export function hasProduct(id: string): boolean {
  return PRODUCTS.some((p) => p.id === id);
}

/** All catalog entries (defensive copy so callers cannot mutate the table). */
export function listProducts(): Product[] {
  return PRODUCTS.map((p) => ({ ...p }));
}

/** Products in a given tax category — used by reporting, not billing. */
export function productsInCategory(category: TaxCategory): Product[] {
  return PRODUCTS.filter((p) => p.taxCategory === category).map((p) => ({ ...p }));
}
