/**
 * Display formatting for monetary amounts. Formatting is the last step of
 * the pipeline and never feeds back into arithmetic.
 */

import { getCurrency, type CurrencyCode } from "./currency";

/**
 * Format integer minor units as a currency string, e.g. 123456 -> "$1,234.56".
 * The input must already be integer cents; fractional inputs indicate an
 * upstream bug and are surfaced verbatim to make them visible in receipts.
 */
export function formatCents(amountMinor: number, code: CurrencyCode): string {
  const info = getCurrency(code);
  const negative = amountMinor < 0;
  const abs = Math.abs(amountMinor);

  if (info.minorUnits === 0) {
    return `${negative ? "-" : ""}${info.symbol}${groupThousands(String(abs))}`;
  }

  const divisor = Math.pow(10, info.minorUnits);
  const major = Math.floor(abs / divisor);
  const minor = abs - major * divisor;
  const minorStr = String(minor).padStart(info.minorUnits, "0");
  return `${negative ? "-" : ""}${info.symbol}${groupThousands(String(major))}.${minorStr}`;
}

/** Insert thousands separators into a plain digit string. */
function groupThousands(digits: string): string {
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    const fromEnd = digits.length - i;
    out += digits[i];
    if (fromEnd > 1 && (fromEnd - 1) % 3 === 0 && !digits.includes(".")) {
      out += ",";
    }
  }
  return out;
}

/** Format a percentage for receipts, trimming trailing zeros: 8.25 -> "8.25%". */
export function formatPercent(percent: number): string {
  const fixed = percent.toFixed(2).replace(/\.?0+$/, "");
  return `${fixed}%`;
}

/** Right-align an amount string within a fixed-width receipt column. */
export function padAmount(formatted: string, width: number): string {
  if (formatted.length >= width) return formatted;
  return " ".repeat(width - formatted.length) + formatted;
}
