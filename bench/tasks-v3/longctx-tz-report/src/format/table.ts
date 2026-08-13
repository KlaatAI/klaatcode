/**
 * Plain-text table rendering for org reports. Presentation only — no
 * bucketing decisions are made here.
 */

import type { OrgReport, DailyRow, WeeklyRow } from "../analytics/types";
import { OrgRegistry, type Org } from "../orgs/registry";

const DAILY_HEADERS = ["day", "active", "sessions", "events"] as const;
const WEEKLY_HEADERS = ["week of", "active-days", "sessions", "events"] as const;

function padCell(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function renderRows(headers: readonly string[], rows: string[][]): string {
  const widths = headers.map((h, i) => {
    let w = h.length;
    for (const row of rows) {
      const cell = row[i] ?? "";
      if (cell.length > w) {
        w = cell.length;
      }
    }
    return w;
  });

  const lines: string[] = [];
  lines.push(headers.map((h, i) => padCell(h, widths[i]!)).join("  "));
  lines.push(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) {
    lines.push(row.map((cell, i) => padCell(cell, widths[i]!)).join("  "));
  }
  return lines.join("\n");
}

function dailyRowCells(row: DailyRow): string[] {
  return [
    row.day,
    String(row.activeUsers),
    String(row.sessionCount),
    String(row.eventCount),
  ];
}

function weeklyRowCells(row: WeeklyRow): string[] {
  return [
    row.weekStart,
    String(row.activeUserDays),
    String(row.sessionCount),
    String(row.eventCount),
  ];
}

/** Renders the daily section of a report as a plain-text table. */
export function renderDailyTable(report: OrgReport): string {
  return renderRows(DAILY_HEADERS, report.rows.map(dailyRowCells));
}

/** Renders the weekly section of a report as a plain-text table. */
export function renderWeeklyTable(report: OrgReport): string {
  return renderRows(WEEKLY_HEADERS, report.weekly.map(weeklyRowCells));
}

/** Full report: header line, daily table, blank line, weekly table. */
export function renderReport(report: OrgReport, org: Org): string {
  const offset = OrgRegistry.formatOffset(org.utcOffsetMinutes);
  const header = `Daily active report — ${org.name} (${org.id}, UTC${offset})`;
  return [
    header,
    "=".repeat(header.length),
    renderDailyTable(report),
    "",
    renderWeeklyTable(report),
  ].join("\n");
}
