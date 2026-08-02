/** Tiny invariant helpers used across the pipeline. */

export function invariant(cond: unknown, message: string): asserts cond {
  if (!cond) {
    throw new Error(`invariant violated: ${message}`);
  }
}

export function assertFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number, got ${String(value)}`);
  }
  return value;
}

export function assertNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

/** Exhaustiveness helper for switch statements. */
export function unreachable(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}
