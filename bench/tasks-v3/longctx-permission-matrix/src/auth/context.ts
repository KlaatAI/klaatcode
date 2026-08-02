/**
 * Request context: who is calling.
 *
 * Built once per request by the router from the (already authenticated)
 * actor. Authorization decisions downstream read only this object.
 */

import { type Role, parseRole } from "./roles";

export interface Actor {
  userId: string;
  role: string;
}

export interface RequestContext {
  userId: string;
  role: Role;
  /** Request id for audit correlation. Deterministic per dispatch. */
  requestId: string;
}

let requestCounter = 0;

/** Reset the request counter (tests only, keeps ids deterministic). */
export function resetRequestIds(): void {
  requestCounter = 0;
}

export function buildContext(actor: Actor): RequestContext {
  if (!actor.userId) {
    throw new Error("actor.userId is required");
  }
  requestCounter += 1;
  return {
    userId: actor.userId,
    role: parseRole(actor.role),
    requestId: `req-${requestCounter}`,
  };
}
