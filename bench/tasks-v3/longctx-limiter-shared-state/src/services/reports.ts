import type { Context } from "../http/types";
import { jsonOk } from "../http/types";
import type { Clock } from "../util/clock";

interface ReportRow {
  id: string;
  ownerId: string;
  title: string;
  createdAt: number;
}

/**
 * Reports service. Holds a small deterministic in-memory dataset; the list
 * endpoint filters to the caller's own rows so responses differ per user,
 * which the tests use to prove requests really reached the handler.
 */
export class ReportsService {
  private readonly rows: ReportRow[];
  private nextSeq = 1;

  constructor(private readonly clock: Clock) {
    const base = 1_699_990_000_000;
    this.rows = [
      { id: "rep-001", ownerId: "alice", title: "Q1 usage", createdAt: base },
      { id: "rep-002", ownerId: "alice", title: "Churn deep-dive", createdAt: base + 60_000 },
      { id: "rep-003", ownerId: "bob", title: "Billing anomalies", createdAt: base + 120_000 },
      { id: "rep-004", ownerId: "carol", title: "Latency percentiles", createdAt: base + 180_000 },
    ];
  }

  /** GET /reports — the caller's reports, oldest first. */
  async list(ctx: Context): Promise<void> {
    const userId = ctx.state.userId!;
    const mine = this.rows
      .filter((r) => r.ownerId === userId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((r) => ({ id: r.id, title: r.title }));
    jsonOk(ctx, { owner: userId, reports: mine });
  }

  /** POST /reports — create a report owned by the caller. */
  async create(ctx: Context): Promise<void> {
    const userId = ctx.state.userId!;
    const title =
      typeof (ctx.req.body as { title?: unknown } | undefined)?.title === "string"
        ? ((ctx.req.body as { title: string }).title)
        : "untitled";
    const row: ReportRow = {
      id: `rep-new-${this.nextSeq++}`,
      ownerId: userId,
      title,
      createdAt: this.clock.now(),
    };
    this.rows.push(row);
    jsonOk(ctx, { id: row.id, title: row.title }, 201);
  }
}
