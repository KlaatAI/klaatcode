import type { Middleware } from "../http/types";
import type { Clock } from "../util/clock";

/** One immutable audit event for a mutating request. */
export interface AuditEvent {
  at: number;
  actorId: string;
  action: string;
  target: string;
  outcome: "allowed" | "rejected";
  status: number;
}

/**
 * Audit trail for mutating requests (POST/PUT/PATCH/DELETE).
 *
 * Compliance requires a durable record of who attempted which mutation and
 * whether it succeeded — including mutations rejected by rate limiting or
 * authorization. Read-only traffic is deliberately excluded to keep the
 * trail small.
 *
 * The trail is append-only; nothing in the app mutates or deletes events.
 */
export class AuditTrail {
  private readonly events: AuditEvent[] = [];

  append(event: AuditEvent): void {
    this.events.push(event);
  }

  /** All events, oldest first. Returns a defensive copy. */
  all(): AuditEvent[] {
    return this.events.slice();
  }

  /** Events attributed to one actor. */
  forActor(actorId: string): AuditEvent[] {
    return this.events.filter((e) => e.actorId === actorId);
  }

  /** Count of rejected mutations, a common alerting signal. */
  rejectedCount(): number {
    return this.events.filter((e) => e.outcome === "rejected").length;
  }
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Middleware recording audit events. Runs after authentication so events
 * carry verified actor ids; wraps the rest of the chain so rejections
 * (403/422/429) are captured with their final status.
 */
export function auditMutations(trail: AuditTrail, clock: Clock): Middleware {
  return async (ctx, next) => {
    if (!MUTATING.has(ctx.req.method)) {
      await next();
      return;
    }
    const at = clock.now();
    await next();
    trail.append({
      at,
      actorId: ctx.state.userId ?? "anonymous",
      action: `${ctx.req.method} ${ctx.req.path.split("?")[0]}`,
      target: ctx.req.path.split("?")[0]!,
      outcome: ctx.res.status < 400 ? "allowed" : "rejected",
      status: ctx.res.status,
    });
  };
}
