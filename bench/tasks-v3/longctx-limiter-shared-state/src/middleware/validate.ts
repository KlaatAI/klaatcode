import type { Middleware } from "../http/types";
import { jsonError } from "../http/types";

/** Declarative body rule for a single route. */
export interface BodyRule {
  method: string;
  path: string;
  /** Required string fields and their maximum lengths. */
  fields: Record<string, { maxLength: number; required: boolean }>;
}

/**
 * Body validation middleware.
 *
 * Applies declarative rules to mutating requests before they reach the
 * services. Rules are matched on exact method+path (parameterized paths are
 * validated inside handlers instead, where route params are available).
 * Requests without a matching rule pass through untouched, so read-only
 * endpoints pay no validation cost.
 */
export function validateBody(rules: BodyRule[]): Middleware {
  const index = new Map<string, BodyRule>();
  for (const rule of rules) {
    index.set(`${rule.method} ${rule.path}`, rule);
  }

  return async (ctx, next) => {
    const rule = index.get(`${ctx.req.method} ${ctx.req.path.split("?")[0]}`);
    if (!rule) {
      await next();
      return;
    }

    const body = ctx.req.body;
    if (body === undefined || body === null || typeof body !== "object") {
      jsonError(ctx, 400, "request body must be a JSON object");
      return;
    }

    for (const [field, spec] of Object.entries(rule.fields)) {
      const value = (body as Record<string, unknown>)[field];
      if (value === undefined) {
        if (spec.required) {
          jsonError(ctx, 422, `missing required field '${field}'`);
          return;
        }
        continue;
      }
      if (typeof value !== "string") {
        jsonError(ctx, 422, `field '${field}' must be a string`);
        return;
      }
      if (value.length > spec.maxLength) {
        jsonError(ctx, 422, `field '${field}' exceeds ${spec.maxLength} characters`);
        return;
      }
    }

    await next();
  };
}

/** Rules for the routes this app exposes. */
export const APP_BODY_RULES: BodyRule[] = [
  {
    method: "POST",
    path: "/reports",
    fields: {
      title: { maxLength: 200, required: false },
    },
  },
];
