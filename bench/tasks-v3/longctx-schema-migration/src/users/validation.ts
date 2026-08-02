import type { User, UserPreferences } from "./types";

export class ValidationError extends Error {
  constructor(readonly field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = "ValidationError";
  }
}

const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;

export function validateEmail(email: string): void {
  if (email !== email.toLowerCase()) {
    throw new ValidationError("email", "must be lowercase");
  }
  if (!EMAIL_RE.test(email)) {
    throw new ValidationError("email", `not a valid address: ${email}`);
  }
}

/**
 * Display names (post-migration-0007 canonical name field) must be 1-40
 * characters, trimmed, and must not contain control characters.
 */
export function validateDisplayName(displayName: string): void {
  if (displayName.trim() !== displayName) {
    throw new ValidationError("displayName", "must not have surrounding whitespace");
  }
  if (displayName.length === 0) {
    throw new ValidationError("displayName", "must not be empty");
  }
  if (displayName.length > 40) {
    throw new ValidationError("displayName", "must be at most 40 characters");
  }
  for (const ch of displayName) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      throw new ValidationError("displayName", "contains control characters");
    }
  }
}

export function validateTimezone(tz: string): void {
  if (!/^[A-Za-z]+(\/[A-Za-z_+-]+){0,2}$/.test(tz)) {
    throw new ValidationError("timezone", `not an IANA zone name: ${tz}`);
  }
}

export function validateDigestHour(hour: number): void {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new ValidationError("digestHour", "must be an integer 0-23");
  }
}

/** Full-record validation used by the store on insert/update. */
export function assertValidUser(user: User): void {
  validateEmail(user.email);
  validateDisplayName(user.displayName);
  validateTimezone(user.timezone);
  if (user.fullName.trim().length === 0) {
    throw new ValidationError("fullName", "must not be empty");
  }
  if (Number.isNaN(Date.parse(user.createdAt))) {
    throw new ValidationError("createdAt", "must be an ISO-8601 timestamp");
  }
}

export function assertValidPreferences(prefs: UserPreferences): void {
  validateDigestHour(prefs.digestHour);
  const themes = ["light", "dark", "system"];
  if (!themes.includes(prefs.theme)) {
    throw new ValidationError("theme", `unknown theme ${prefs.theme}`);
  }
  const freqs = ["daily", "weekly", "never"];
  if (!freqs.includes(prefs.digestFrequency)) {
    throw new ValidationError("digestFrequency", `unknown value ${prefs.digestFrequency}`);
  }
}
