/**
 * Tax jurisdiction table.
 *
 * Rates are expressed as decimal fractions (0.0825 = 8.25%). Each
 * jurisdiction defines a rate per tax category; `exempt` is always zero
 * regardless of jurisdiction.
 */

import type { TaxCategory } from "../catalog/products";

export interface Jurisdiction {
  code: string;
  name: string;
  rates: Record<TaxCategory, number>;
}

const JURISDICTIONS: Record<string, Jurisdiction> = {
  CA: {
    code: "CA",
    name: "California",
    rates: { standard: 0.0825, reduced: 0.03, exempt: 0 },
  },
  NY: {
    code: "NY",
    name: "New York",
    rates: { standard: 0.08875, reduced: 0.04, exempt: 0 },
  },
  TX: {
    code: "TX",
    name: "Texas",
    rates: { standard: 0.0625, reduced: 0.0125, exempt: 0 },
  },
  OR: {
    code: "OR",
    name: "Oregon",
    rates: { standard: 0, reduced: 0, exempt: 0 },
  },
  WA: {
    code: "WA",
    name: "Washington",
    rates: { standard: 0.065, reduced: 0.02, exempt: 0 },
  },
};

/** Look up a jurisdiction. Throws for unknown codes. */
export function getJurisdiction(code: string): Jurisdiction {
  const j = JURISDICTIONS[code];
  if (!j) {
    throw new Error(`Unknown tax jurisdiction: ${code}`);
  }
  return j;
}

/** The applicable rate for a category within a jurisdiction. */
export function rateFor(jurisdictionCode: string, category: TaxCategory): number {
  const j = getJurisdiction(jurisdictionCode);
  const rate = j.rates[category];
  if (rate === undefined) {
    throw new Error(`No ${category} rate configured for ${jurisdictionCode}`);
  }
  return rate;
}

/** All jurisdiction codes, for validation error messages. */
export function jurisdictionCodes(): string[] {
  return Object.keys(JURISDICTIONS);
}
