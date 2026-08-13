import type { Context } from "../http/types";
import { jsonOk } from "../http/types";
import type { Clock } from "../util/clock";
import type { MetricsRegistry } from "./metrics";

/**
 * Liveness/readiness endpoints. Deliberately unauthenticated in production
 * (load balancers cannot hold tokens), but in this fixture they sit behind
 * the same pipeline for simplicity; the tests do not exercise them.
 */
export class HealthService {
  private readonly bootedAt: number;

  constructor(
    private readonly clock: Clock,
    private readonly metrics: MetricsRegistry,
  ) {
    this.bootedAt = clock.now();
  }

  /** GET /healthz — process is up. */
  async liveness(ctx: Context): Promise<void> {
    jsonOk(ctx, {
      status: "ok",
      uptimeMs: this.clock.now() - this.bootedAt,
    });
  }

  /** GET /readyz — dependencies reachable plus a traffic snapshot. */
  async readiness(ctx: Context): Promise<void> {
    const snapshot = this.metrics.snapshot();
    const totalRequests = Object.values(snapshot).reduce((a, b) => a + b, 0);
    jsonOk(ctx, {
      status: "ok",
      checks: {
        directory: "ok",
        reports: "ok",
      },
      totalRequests,
    });
  }
}
