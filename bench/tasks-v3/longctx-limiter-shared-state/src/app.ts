import type { KRequest, KResponse } from "./http/types";
import { compose, execute } from "./http/pipeline";
import { Router } from "./http/router";
import { authenticate } from "./middleware/auth";
import { requestId } from "./middleware/requestId";
import { cors } from "./middleware/cors";
import { deadline } from "./middleware/timeout";
import { accessLog, LogStore } from "./middleware/logging";
import { rateLimit } from "./middleware/rateLimit";
import { validateBody, APP_BODY_RULES } from "./middleware/validate";
import { Directory } from "./services/directory";
import { AccountsService } from "./services/accounts";
import { ReportsService } from "./services/reports";
import { HealthService } from "./services/health";
import { MetricsRegistry, collectMetrics } from "./services/metrics";
import { AuditTrail, auditMutations } from "./services/audit";
import type { Clock } from "./util/clock";
import { SystemClock } from "./util/clock";

export interface AppOptions {
  clock?: Clock;
  /** Requests allowed per user per window. Default 60. */
  rateLimitPerWindow?: number;
  /** Window length in ms. Default 60_000. */
  rateLimitWindowMs?: number;
  /** Per-request deadline in ms. Default 5_000. */
  deadlineMs?: number;
}

export interface App {
  /** Run one request through the full middleware + routing pipeline. */
  handle(req: KRequest): Promise<KResponse>;
  /** Access-log sink populated by the logging middleware. */
  logs: LogStore;
  /** Aggregated request metrics (global by design, unlike rate limits). */
  metrics: MetricsRegistry;
  /** Append-only audit trail of mutating requests. */
  audit: AuditTrail;
}

/**
 * Build a fully wired application instance.
 *
 * Middleware order (outermost first):
 *   requestId -> cors -> deadline -> metrics -> accessLog
 *     -> authenticate -> rateLimit -> auditMutations -> validateBody
 *     -> router
 *
 * The order matters: logging and metrics wrap everything downstream so
 * throttled requests still show up in both; authentication precedes rate
 * limiting so budgets are keyed by verified user ids rather than by
 * whatever a client claims about itself; auditing sits after the limiter so
 * the trail records the final outcome of each mutation attempt.
 */
export function buildApp(options: AppOptions = {}): App {
  const clock = options.clock ?? new SystemClock();
  const limit = options.rateLimitPerWindow ?? 60;
  const windowMs = options.rateLimitWindowMs ?? 60_000;
  const deadlineMs = options.deadlineMs ?? 5_000;

  const directory = new Directory();
  const accounts = new AccountsService(directory);
  const reports = new ReportsService(clock);
  const metrics = new MetricsRegistry();
  const health = new HealthService(clock, metrics);
  const audit = new AuditTrail();
  const logs = new LogStore();

  const router = new Router();
  router.get("/healthz", (ctx) => health.liveness(ctx));
  router.get("/readyz", (ctx) => health.readiness(ctx));
  router.get("/accounts/me", (ctx) => accounts.me(ctx));
  router.get("/accounts/:id", (ctx) => accounts.byId(ctx));
  router.get("/reports", (ctx) => reports.list(ctx));
  router.post("/reports", (ctx) => reports.create(ctx));

  const handler = compose(
    [
      requestId(),
      cors(),
      deadline(deadlineMs),
      collectMetrics(metrics, clock),
      accessLog(logs, clock),
      authenticate(directory),
      rateLimit({ limit, windowMs, clock }),
      auditMutations(audit, clock),
      validateBody(APP_BODY_RULES),
    ],
    router.dispatch(),
  );

  return {
    handle: (req) => execute(handler, req),
    logs,
    metrics,
    audit,
  };
}
