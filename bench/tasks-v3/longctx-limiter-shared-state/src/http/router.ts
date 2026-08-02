import type { Context, Handler, Method } from "./types";
import { jsonError } from "./types";

interface RouteEntry {
  method: Method;
  /** Path pattern split into segments; `:name` segments capture params. */
  segments: string[];
  handler: Handler;
}

/**
 * Small exact/param-segment router. Patterns look like
 * `/accounts/:id/profile`; a `:name` segment matches any single non-empty
 * path segment and records it under `ctx.state.routeParams[name]`.
 *
 * Matching is method-sensitive. When no route matches, the router writes a
 * 404 JSON error to the response.
 */
export class Router {
  private readonly routes: RouteEntry[] = [];

  register(method: Method, pattern: string, handler: Handler): void {
    if (!pattern.startsWith("/")) {
      throw new Error(`Router.register: pattern must start with '/', got '${pattern}'`);
    }
    this.routes.push({
      method,
      segments: splitPath(pattern),
      handler,
    });
  }

  get(pattern: string, handler: Handler): void {
    this.register("GET", pattern, handler);
  }

  post(pattern: string, handler: Handler): void {
    this.register("POST", pattern, handler);
  }

  /** Find the first registered route matching the request, if any. */
  private match(method: Method, path: string): { entry: RouteEntry; params: Record<string, string> } | undefined {
    const parts = splitPath(path);
    for (const entry of this.routes) {
      if (entry.method !== method) continue;
      if (entry.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < entry.segments.length; i++) {
        const seg = entry.segments[i]!;
        const part = parts[i]!;
        if (seg.startsWith(":")) {
          if (part.length === 0) {
            ok = false;
            break;
          }
          params[seg.slice(1)] = decodeURIComponent(part);
        } else if (seg !== part) {
          ok = false;
          break;
        }
      }
      if (ok) return { entry, params };
    }
    return undefined;
  }

  /** Terminal handler suitable for the end of a middleware chain. */
  dispatch(): Handler {
    return async (ctx: Context) => {
      const found = this.match(ctx.req.method, ctx.req.path);
      if (!found) {
        jsonError(ctx, 404, `no route for ${ctx.req.method} ${ctx.req.path}`);
        return;
      }
      ctx.state.routeParams = found.params;
      await found.entry.handler(ctx);
    };
  }
}

function splitPath(path: string): string[] {
  const noQuery = path.split("?")[0]!;
  return noQuery.split("/").filter((s) => s.length > 0);
}
