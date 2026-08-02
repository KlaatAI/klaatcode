import type { Middleware } from "../http/types";
import type { Clock } from "../util/clock";
import { statusClass } from "../http/status";

interface SeriesPoint {
  at: number;
  durationMs: number;
}

/**
 * In-process request metrics.
 *
 * Collects per-route counters bucketed by status class plus a bounded ring
 * of recent latency samples. This mirrors what the production service ships
 * to the metrics agent; here it is queryable in-process so operators (and
 * tests) can introspect traffic shape without a sidecar.
 *
 * NOTE: metrics are aggregated across ALL users on purpose — unlike rate
 * limit budgets, which are strictly per-user, a route's traffic counters are
 * global by design.
 */
export class MetricsRegistry {
  private readonly counters = new Map<string, number>();
  private readonly samples = new Map<string, SeriesPoint[]>();
  private static readonly MAX_SAMPLES = 256;

  increment(route: string, status: number): void {
    const key = `${route}|${statusClass(status)}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  observe(route: string, point: SeriesPoint): void {
    let ring = this.samples.get(route);
    if (!ring) {
      ring = [];
      this.samples.set(route, ring);
    }
    ring.push(point);
    if (ring.length > MetricsRegistry.MAX_SAMPLES) {
      ring.shift();
    }
  }

  /** Counter value for a route + status class, e.g. ("/reports", "2xx"). */
  count(route: string, klass: string): number {
    return this.counters.get(`${route}|${klass}`) ?? 0;
  }

  /** p50-ish latency from the recent-sample ring (median of samples). */
  medianLatency(route: string): number {
    const ring = this.samples.get(route);
    if (!ring || ring.length === 0) return 0;
    const sorted = ring.map((p) => p.durationMs).sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)]!;
  }

  snapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [key, value] of this.counters) {
      out[key] = value;
    }
    return out;
  }
}

/**
 * Middleware that records one counter increment and one latency sample per
 * request, keyed by the raw request path (not the matched route pattern —
 * good enough for this fixture's fixed set of paths).
 */
export function collectMetrics(registry: MetricsRegistry, clock: Clock): Middleware {
  return async (ctx, next) => {
    const start = clock.now();
    await next();
    const route = ctx.req.path.split("?")[0]!;
    registry.increment(route, ctx.res.status);
    registry.observe(route, { at: start, durationMs: clock.now() - start });
  };
}
