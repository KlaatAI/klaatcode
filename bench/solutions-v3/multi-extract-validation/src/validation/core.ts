// Shared validation core — the single source of truth for input validation.

export class ValidationError extends Error {
  readonly field: string;
  constructor(message: string, field: string) {
    super(message);
    this.name = "ValidationError";
    this.field = field;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COUNTRY_RE = /^[A-Z]{2}$/;

export function validateEmail(raw: string, field: string = "email"): string {
  const normalized = raw.trim().toLowerCase();
  if (!EMAIL_RE.test(normalized)) {
    throw new ValidationError(`${field} must be a valid email address`, field);
  }
  return normalized;
}

export function validateName(raw: string, field: string = "name"): string {
  const trimmed = raw.trim();
  if (trimmed.length < 1 || trimmed.length > 80) {
    throw new ValidationError(`${field} must be 1-80 characters`, field);
  }
  return trimmed;
}

export function validateCountry(raw: string, field: string = "country"): string {
  const normalized = raw.trim().toUpperCase();
  if (!COUNTRY_RE.test(normalized)) {
    throw new ValidationError(`${field} must be a 2-letter country code`, field);
  }
  return normalized;
}
