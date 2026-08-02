/**
 * CSV export for org reports. Presentation only.
 */

import type { OrgReport } from "../analytics/types";

function escapeCsvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function line(fields: (string | number)[]): string {
  return fields.map((f) => escapeCsvField(String(f))).join(",");
}

/** Daily rows as CSV, with a header line. */
export function dailyCsv(report: OrgReport): string {
  const lines: string[] = [line(["day", "active_users", "sessions", "events"])];
  for (const row of report.rows) {
    lines.push(line([row.day, row.activeUsers, row.sessionCount, row.eventCount]));
  }
  return lines.join("\n");
}

/** Weekly rows as CSV, with a header line. */
export function weeklyCsv(report: OrgReport): string {
  const lines: string[] = [
    line(["week_start", "active_user_days", "sessions", "events"]),
  ];
  for (const row of report.weekly) {
    lines.push(
      line([row.weekStart, row.activeUserDays, row.sessionCount, row.eventCount]),
    );
  }
  return lines.join("\n");
}

/** Both sections concatenated with a blank separator line. */
export function fullCsv(report: OrgReport): string {
  return `${dailyCsv(report)}\n\n${weeklyCsv(report)}`;
}
