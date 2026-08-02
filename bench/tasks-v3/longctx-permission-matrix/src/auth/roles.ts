/**
 * Role model.
 *
 * Exactly three roles, strictly ordered by privilege:
 *
 *   viewer < editor < admin
 *
 * Roles are additive: everything a viewer may do, an editor may also do;
 * everything an editor may do, an admin may also do. Capability checks
 * therefore reduce to "is the actor's role at least the capability's
 * minimum role" — see src/auth/permissions.ts for the matrix.
 */

export type Role = "viewer" | "editor" | "admin";

export const ALL_ROLES: readonly Role[] = ["viewer", "editor", "admin"];

const RANK: Record<Role, number> = {
  viewer: 0,
  editor: 1,
  admin: 2,
};

export function isRole(value: unknown): value is Role {
  return value === "viewer" || value === "editor" || value === "admin";
}

/** True when `actual` is the same role as `atLeast` or a superior one. */
export function roleAtLeast(actual: Role, atLeast: Role): boolean {
  return RANK[actual] >= RANK[atLeast];
}

/** Numeric rank, exposed for sorting/debugging only. */
export function roleRank(role: Role): number {
  return RANK[role];
}

/** Parses an untrusted string into a Role or throws. */
export function parseRole(value: string): Role {
  if (!isRole(value)) {
    throw new Error(`unknown role: ${JSON.stringify(value)}`);
  }
  return value;
}
