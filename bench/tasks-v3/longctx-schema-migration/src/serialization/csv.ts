import type { User } from "../users/types";

/**
 * CSV export used by the admin "download users" action. Columns follow
 * the post-migration schema (displayName, not nickname).
 */

export const CSV_COLUMNS = [
  "id",
  "email",
  "displayName",
  "fullName",
  "locale",
  "timezone",
  "createdAt",
  "status",
] as const;

function escapeField(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function userToCsvRow(user: User): string {
  return CSV_COLUMNS.map((col) => escapeField(String(user[col]))).join(",");
}

export function usersToCsv(users: User[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const user of users) {
    lines.push(userToCsvRow(user));
  }
  return lines.join("\n") + "\n";
}

/** Parses a single header line and verifies it matches the schema. */
export function assertCsvHeader(headerLine: string): void {
  const expected = CSV_COLUMNS.join(",");
  if (headerLine.trim() !== expected) {
    throw new Error(`csv header mismatch: expected "${expected}", got "${headerLine.trim()}"`);
  }
}
