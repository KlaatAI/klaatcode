// Shared validation core — the single source of truth for input validation.
//
// UNIFIED RULES (all call sites must behave exactly like this):
//
// ValidationError: extends Error, name === "ValidationError", carries the
// offending `field` name as a readonly property.
//
// validateEmail(raw, field = "email"): string
//   - trim surrounding whitespace, then lowercase the whole address
//   - must match /^[^\s@]+@[^\s@]+\.[^\s@]+$/ (local@domain.tld, no spaces)
//   - returns the normalized (trimmed + lowercased) address
//   - otherwise throws ValidationError(`${field} must be a valid email address`, field)
//
// validateName(raw, field = "name"): string
//   - trim surrounding whitespace; inner casing/spacing preserved
//   - trimmed value must be 1..80 characters long
//   - returns the trimmed value
//   - otherwise throws ValidationError(`${field} must be 1-80 characters`, field)
//
// validateCountry(raw, field = "country"): string
//   - trim surrounding whitespace, then uppercase
//   - must match /^[A-Z]{2}$/ (exactly two ASCII letters — digits are invalid)
//   - returns the normalized (trimmed + uppercased) code
//   - otherwise throws ValidationError(`${field} must be a 2-letter country code`, field)

export class ValidationError extends Error {
  readonly field: string;
  constructor(message: string, field: string) {
    super(message);
    this.name = "ValidationError";
    this.field = field;
  }
}

export function validateEmail(raw: string, field: string = "email"): string {
  // TODO: implement per the unified rules above.
  throw new Error("TODO: validateEmail not implemented");
}

export function validateName(raw: string, field: string = "name"): string {
  // TODO: implement per the unified rules above.
  throw new Error("TODO: validateName not implemented");
}

export function validateCountry(raw: string, field: string = "country"): string {
  // TODO: implement per the unified rules above.
  throw new Error("TODO: validateCountry not implemented");
}
