/**
 * Currency metadata used across the pricing and billing pipeline.
 *
 * All monetary amounts in this codebase are represented as integer *minor
 * units* (cents for USD/EUR, yen for JPY, etc). See `money/round.ts` for the
 * rounding conventions that keep them integral.
 */

export type CurrencyCode = "USD" | "EUR" | "GBP" | "JPY" | "CAD";

export interface CurrencyInfo {
  code: CurrencyCode;
  /** Symbol used by the receipt formatter. */
  symbol: string;
  /** Number of minor-unit digits (2 for cents, 0 for yen). */
  minorUnits: number;
  /** Human-readable name for logs and receipts. */
  name: string;
}

const CURRENCIES: Record<CurrencyCode, CurrencyInfo> = {
  USD: { code: "USD", symbol: "$", minorUnits: 2, name: "US Dollar" },
  EUR: { code: "EUR", symbol: "€", minorUnits: 2, name: "Euro" },
  GBP: { code: "GBP", symbol: "£", minorUnits: 2, name: "Pound Sterling" },
  JPY: { code: "JPY", symbol: "¥", minorUnits: 0, name: "Japanese Yen" },
  CAD: { code: "CAD", symbol: "CA$", minorUnits: 2, name: "Canadian Dollar" },
};

/** Look up currency metadata. Throws for unsupported codes. */
export function getCurrency(code: string): CurrencyInfo {
  const info = CURRENCIES[code as CurrencyCode];
  if (!info) {
    throw new Error(`Unsupported currency: ${code}`);
  }
  return info;
}

/** True when the code is one we can invoice in. */
export function isSupportedCurrency(code: string): code is CurrencyCode {
  return Object.prototype.hasOwnProperty.call(CURRENCIES, code);
}

/**
 * Convert an integer minor-unit amount to a decimal major-unit number.
 * Only for display purposes — arithmetic must stay in minor units.
 */
export function toMajorUnits(amountMinor: number, code: CurrencyCode): number {
  const { minorUnits } = getCurrency(code);
  return amountMinor / Math.pow(10, minorUnits);
}

/** List of supported codes, for validation error messages. */
export function supportedCurrencyCodes(): CurrencyCode[] {
  return Object.keys(CURRENCIES) as CurrencyCode[];
}
