/**
 * Small argument-validation helpers shared by the repository and service
 * layers. All of these throw `ValidationError` so API adapters can map the
 * failures to 400 responses uniformly.
 */

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * Page sizes must be positive integers and are capped to keep a single page
 * from materializing the whole table.
 */
export const MAX_PAGE_SIZE = 100;

export function assertValidLimit(limit: number): void {
  if (!Number.isInteger(limit)) {
    throw new ValidationError(`limit must be an integer, got ${limit}`);
  }
  if (limit < 1) {
    throw new ValidationError(`limit must be >= 1, got ${limit}`);
  }
  if (limit > MAX_PAGE_SIZE) {
    throw new ValidationError(
      `limit must be <= ${MAX_PAGE_SIZE}, got ${limit}`,
    );
  }
}

export function assertNonEmptyString(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`${field} must be a non-empty string`);
  }
}

export function assertEpochMillis(value: number, field: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new ValidationError(
      `${field} must be a non-negative integer epoch-milliseconds value`,
    );
  }
}
