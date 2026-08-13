import type { Middleware } from "../http/types";
import type { Clock } from "../util/clock";

/** One structured access-log entry per completed request. */
export interface AccessLogEntry {
  requestId: string;
  method: string;
  path: string;
  userId: string;
  status: number;
  durationMs: number;
  at: number;
}

/** Append-only sink the logging middleware writes into. */
export class LogStore {
  readonly entries: AccessLogEntry[] = [];

  append(entry: AccessLogEntry): void {
    this.entries.push(entry);
  }

  /** Entries for one user, in arrival order. */
  forUser(userId: string): AccessLogEntry[] {
    return this.entries.filter((e) => e.userId === userId);
  }

  clear(): void {
    this.entries.length = 0;
  }
}

/**
 * Access logging middleware. Wraps the remainder of the chain, timing it and
 * appending one entry per request — including requests rejected further down
 * (rate-limited requests are logged with their 429 status).
 */
export function accessLog(store: LogStore, clock: Clock): Middleware {
  return async (ctx, next) => {
    const startedAt = clock.now();
    ctx.state.startedAt = startedAt;
    await next();
    store.append({
      requestId: ctx.state.requestId ?? "unassigned",
      method: ctx.req.method,
      path: ctx.req.path,
      userId: ctx.state.userId ?? "anonymous",
      status: ctx.res.status,
      durationMs: clock.now() - startedAt,
      at: startedAt,
    });
  };
}
