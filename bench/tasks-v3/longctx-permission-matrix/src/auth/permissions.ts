/**
 * Capability matrix — the single source of truth for authorization.
 *
 * Every route names exactly one capability, and every capability maps to
 * the MINIMUM role allowed to exercise it. The matrix below is the
 * documented contract; route handlers must not invent their own checks.
 *
 *   capability        | minimum role | notes
 *   ------------------+--------------+---------------------------------
 *   user:read         | viewer       | listing and reading profiles
 *   user:update       | editor       | profile edits
 *   user:delete       | admin        | deactivation is destructive
 *   project:read      | viewer       | listing and reading projects
 *   project:create    | editor       |
 *   project:update    | editor       |
 *   project:archive   | editor       | archiving is a mutation
 *   billing:read      | viewer       | invoices are visible org-wide
 *   billing:update    | admin        | payment methods are sensitive
 *   audit:read        | admin        |
 *   settings:update   | admin        |
 */

import { type Role, roleAtLeast } from "./roles";

export type Capability =
  | "user:read"
  | "user:update"
  | "user:delete"
  | "project:read"
  | "project:create"
  | "project:update"
  | "project:archive"
  | "billing:read"
  | "billing:update"
  | "audit:read"
  | "settings:update";

/** Minimum role required for each capability. Keep in sync with the table above. */
export const CAPABILITY_MIN_ROLE: Record<Capability, Role> = {
  "user:read": "viewer",
  "user:update": "editor",
  "user:delete": "admin",
  "project:read": "viewer",
  "project:create": "editor",
  "project:update": "editor",
  "project:archive": "editor",
  "billing:read": "viewer",
  "billing:update": "admin",
  "audit:read": "admin",
  "settings:update": "admin",
};

export function isCapability(value: string): value is Capability {
  return value in CAPABILITY_MIN_ROLE;
}

/** True when `role` may exercise `capability` per the matrix. */
export function hasCapability(role: Role, capability: Capability): boolean {
  return roleAtLeast(role, CAPABILITY_MIN_ROLE[capability]);
}

/** All capabilities available to a role (for token introspection UIs). */
export function capabilitiesFor(role: Role): Capability[] {
  return (Object.keys(CAPABILITY_MIN_ROLE) as Capability[]).filter((cap) =>
    hasCapability(role, cap),
  );
}
